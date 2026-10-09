import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';

export const browserBinary = process.env.CHROME_BIN || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
interface CdpResult { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string }; data?: string }
interface Pending { resolve: (value: CdpResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Isolated real browser; every CDP request and wait has a deadline. */
export async function openBrowser(t: TestContext) {
  if (!browserBinary) throw new Error('Install Chromium or set CHROME_BIN to run browser tests.');
  const directory = mkdtempSync(join(tmpdir(), 'gravity-browser-'));
  const child = spawn(browserBinary, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-component-update', '--disable-sync', '--disable-crash-reporter', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  let socket: WebSocket | undefined;
  const requests = new Map<number, Pending>();
  t.after(async () => {
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('Browser closed.')); }
    requests.clear(); socket?.close(); child.kill('SIGTERM'); await delay(250);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  });
  const portFile = join(directory, 'DevToolsActivePort');
  for (let attempt = 0; !existsSync(portFile) && child.exitCode === null && attempt < 100; attempt++) await delay(100);
  if (!existsSync(portFile)) throw new Error(`Chromium could not start. ${stderr}`);
  const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find(target => target.type === 'page');
  if (!page) throw new Error('Chromium did not create a page.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 10000); socket!.onopen = () => { clearTimeout(timer); resolve(); }; socket!.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }; });
  let serial = 0;
  const errors: string[] = [];
  let dialogHandler: ((message: string) => void) | undefined;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as { id?: number; error?: { message: string }; result: CdpResult; method?: string; params?: { message?: string; exceptionDetails?: { exception?: { description?: string }; text?: string } } };
    if (message.id) { const pending = requests.get(message.id); if (!pending) return; clearTimeout(pending.timer); requests.delete(message.id); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || 'Browser exception');
    if (message.method === 'Page.javascriptDialogOpening') dialogHandler?.(message.params?.message || '');
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<CdpResult>((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    requests.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
  });
  async function evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Browser evaluation failed.');
    return result.result?.value as T;
  }
  async function until(expression: string, label = expression, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { try { if (await evaluate(expression)) return; } catch { /* Navigation replaces the context. */ } await delay(100); }
    throw new Error(`Browser timed out: ${label}\n${await evaluate('document.body.innerText').catch(() => '')}`);
  }
  async function clickExpression(expression: string) {
    await until(`(() => { const element = (${expression}); return element && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'; })()`, 'Clickable visible control');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
    const point = await evaluate<{ x: number; y: number }>(`(() => { const element = (${expression}); element.scrollIntoView({block:'nearest',inline:'nearest'}); const rect = element.getBoundingClientRect(); return {x:rect.left + rect.width / 2,y:rect.top + rect.height / 2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Page.bringToFront');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  return { send, evaluate, until, errors,
    answerNextDialog: (accept: boolean) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { dialogHandler = undefined; reject(new Error('Native confirmation did not appear.')); }, 10000);
      dialogHandler = message => { clearTimeout(timer); dialogHandler = undefined; void send('Page.handleJavaScriptDialog', { accept }).then(() => resolve(message), reject); };
    }),
    navigate: (url: string) => send('Page.navigate', { url }),
    click: async (selector: string) => { await until(`!!document.querySelector(${JSON.stringify(selector)})`); await clickExpression(`document.querySelector(${JSON.stringify(selector)})`); },
    clickText: async (label: string) => { const expression = `Array.from(document.querySelectorAll('button,a')).find(element => element.textContent.trim() === ${JSON.stringify(label)})`; await until(`!!(${expression})`, `Control ${label}`); await clickExpression(expression); },
    fill: async (selector: string, value: string) => {
      await until(`!!document.querySelector(${JSON.stringify(selector)})`);
      await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', {bubbles:true})); })()`);
    },
    key: async (key: string, code = key) => { const windowsVirtualKeyCode = key === 'Escape' ? 27 : key === 'Enter' ? 13 : key === 'Tab' ? 9 : undefined; await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }); },
    screenshot: async (path: string) => { const result = await send('Page.captureScreenshot', { format: 'png' }); if (!result.data) throw new Error('No screenshot was returned.'); writeFileSync(path, Buffer.from(result.data, 'base64')); },
  };
}
