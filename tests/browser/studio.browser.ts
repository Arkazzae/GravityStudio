import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { Store } from '../../apps/server/store.ts';
import { Engine } from '../../apps/server/engine.ts';
import { ModelLibrary } from '../../apps/server/models.ts';
import type { RuntimeSetupStatus } from '../../apps/server/runtime.ts';
import { createStudioServer } from '../../apps/server/http.ts';
import { dualR9700 } from '../hardware/fixtures.ts';
import { completed, fakeComfy } from '../inference/fake-comfy.ts';
import { openBrowser } from './helpers.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const studio = join(root, 'apps/studio');
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as AddressInfo).port; await close(server); return port; }

test('first run selects GPUs, downloads a checkpoint, generates and restores images through the real Studio API', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gravity-studio-browser-'));
  const output = join(root, '.local/screenshots'); await mkdir(output, { recursive: true });
  const store = new Store(directory);
  const inventory = dualR9700();
  inventory.gpus = inventory.gpus.map((gpu, index) => ({ ...gpu, name: 'AMD Radeon AI PRO R9700', pciAddress: index ? '0000:07:00.0' : '0000:03:00.0' }));
  const engine = new Engine(store, { detect: async () => ({ ...inventory, detectedAt: new Date().toISOString() }), pollMs: 100 });
  const comfy = await fakeComfy();
  const otherComfy = await fakeComfy();
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const sharp = require('sharp') as (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };
  comfy.state.outputBytes = Uint8Array.from(await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#24323b"/><rect x="70" y="80" width="628" height="864" rx="4" fill="#344b4c"/><text x="384" y="488" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#d1fe17">COMFYUI PROTOCOL FIXTURE</text><text x="384" y="535" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#e8edeb">Browser integration test · no model inference</text></svg>')).png().toBuffer());
  let completeAutomatically = true;
  const completion = setInterval(() => {
    if (!completeAutomatically) return;
    for (const worker of [comfy, otherComfy]) {
      const pending = worker.state.pending.splice(0);
      for (const prompt of pending) worker.state.history[String(prompt[1])] = completed(prompt);
    }
  }, 150);
  const frontendPort = await freePort();
  const origin = `http://127.0.0.1:${frontendPort}`;
  let runtimeState: RuntimeSetupStatus = { phase: 'idle', busy: false, message: '', error: null, engine: null, workerCount: 0, updatedAt: null };
  let chosenGpuIds: string[] = [];
  let runtimeOperation: Promise<void> | undefined;
  const managedBindings = [
    { id: 'browser-comfy', baseUrl: comfy.url, deviceId: 'amd:9700b' },
    { id: 'browser-comfy-first', baseUrl: otherComfy.url, deviceId: 'amd:9700a' },
  ];
  // Only container execution and the Hugging Face response are fixtures; the owner API,
  // model download, validation, activation, settings and generation use their real code.
  const runtime = {
    status: () => structuredClone(runtimeState),
    managedWorkers: async () => store.settings().workers.length ? structuredClone(managedBindings) : [],
    start: (body: Record<string, unknown>) => {
      chosenGpuIds = body.gpuIds as string[];
      runtimeState = { ...runtimeState, phase: 'building', busy: true, message: 'Preparing the image engine…' };
      runtimeOperation = delay(750).then(async () => {
        const settings = store.settings();
        settings.workers = [
          { id: 'browser-comfy', name: 'GPU 2', baseUrl: comfy.url, enabled: chosenGpuIds.includes('amd:9700b'), deviceIds: ['amd:9700b'], location: 'local', maxConcurrentJobs: 1 },
          { id: 'browser-comfy-first', name: 'GPU 1', baseUrl: otherComfy.url, enabled: chosenGpuIds.includes('amd:9700a'), deviceIds: ['amd:9700a'], location: 'local', maxConcurrentJobs: 1 },
        ];
        const enabledIds = settings.workers.filter(worker => worker.enabled).map(worker => worker.id);
        for (const configuration of settings.modelConfigurations) if (configuration.workerIds.some(id => settings.workers.some(worker => worker.id === id))) configuration.workerIds = [...enabledIds];
        settings.policy.maxConcurrentJobs = enabledIds.length;
        store.saveSettings(settings);
        await mkdir(join(directory, 'runtime'), { recursive: true });
        await writeFile(join(directory, 'runtime/plan.json'), JSON.stringify({ workers: settings.workers }));
        engine.invalidateWorkers();
        runtimeState = { ...runtimeState, phase: 'ready', busy: false, engine: 'podman', workerCount: enabledIds.length, message: 'Ready', updatedAt: new Date().toISOString() };
      });
      return structuredClone(runtimeState);
    },
    close: async () => { await runtimeOperation; },
  };
  const checkpointUrl = 'https://huggingface.co/gravity-fixtures/browser/blob/main/checkpoint.safetensors';
  const source = checkpointUrl.replace('/blob/', '/resolve/');
  const modelId = `hf-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
  const filename = `${modelId}/checkpoint.safetensors`;
  for (const worker of [comfy, otherComfy]) {
    worker.state.info.CheckpointLoaderSimple.input!.required!.ckpt_name = [[filename]];
    worker.state.responseOverride = path => path === '/models/checkpoints' ? { body: JSON.stringify([filename]) } : undefined;
  }
  const header = Buffer.from(JSON.stringify({ fixture: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  const fixtureCheckpoint = Buffer.concat([prefix, header, Buffer.alloc(4)]);
  let finishCheckpointDownload!: () => void;
  const checkpointResponseReady = new Promise<void>(resolve => { finishCheckpointDownload = resolve; });
  t.after(() => finishCheckpointDownload());
  const models = new ModelLibrary(store, engine, { fetch: async input => {
    assert.equal(String(input), source); await checkpointResponseReady;
    return new Response(fixtureCheckpoint, { headers: { 'Content-Length': String(fixtureCheckpoint.length) } });
  } });
  const server = await createStudioServer({ store, engine, runtime, models, allowedOrigins: [origin], setupSecret: 'browser-integration-setup-key' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await engine.start();
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-8000); }); child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-8000); });
  t.after(async () => { clearInterval(completion); child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL'); await server.closeOperations(); await engine.stop(); await close(server); await Promise.all([comfy.close(), otherComfy.close()]); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ } if (child.exitCode !== null) throw new Error(`Next could not start: ${logs}`); if (attempt === 99) throw new Error(`Next startup timed out: ${logs}`); await delay(100); }
  const browser = await openBrowser(t);
  async function clickScopedText(scope: string, label: string) {
    const element = `Array.from(document.querySelectorAll('${scope} button, ${scope} a')).find(element => element.textContent.trim() === ${JSON.stringify(label)})`;
    await browser.until(`!!(${element})`, `${label} in ${scope}`);
    const point = await browser.evaluate<{ x: number; y: number }>(`(() => { const element = (${element}); element.scrollIntoView({block: 'nearest'}); const rect = element.getBoundingClientRect(); return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}; })()`);
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async function openAdvanced() {
    await browser.click('button[aria-label="Advanced settings"]');
    await browser.until("(() => { const panel = document.querySelector('[aria-label=\"Advanced settings\"]:popover-open'); return panel && getComputedStyle(panel).visibility === 'visible'; })()", 'Advanced settings opens');
  }
  async function screenshotPopover(name: string) {
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('[popover]:popover-open').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)");
    await browser.screenshot(join(output, name));
  }
  async function uploadReference() {
    const file = join(directory, 'reference-upload.png');
    await writeFile(file, comfy.state.outputBytes);
    await browser.send('Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      await browser.click('button[aria-label="Add reference image"]');
      const document = await browser.send('DOM.getDocument') as unknown as { root: { nodeId: number } };
      const input = await browser.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: 'input[aria-label="Upload reference images"]' }) as unknown as { nodeId: number };
      assert.ok(input.nodeId, 'Reference upload uses a native file input');
      await browser.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
      await browser.until("!!document.querySelector('button[aria-label=\"Remove reference 1\"]')", 'Device reference upload finishes');
    } finally { await browser.send('Page.setInterceptFileChooserDialog', { enabled: false }); }
  }
  async function assetCategory(label: string) {
    const button = `Array.from(document.querySelectorAll('#reference-picker-dialog nav[aria-label="Asset categories"] button')).find(button => button.textContent.trim().startsWith(${JSON.stringify(label)}))`;
    await browser.until(`!!(${button})`, `Asset category ${label}`);
    await browser.evaluate(`(${button}).focus()`);
    await browser.key('Enter');
    await browser.until(`(${button})?.getAttribute('aria-current') === 'page'`, `${label} asset category selected`);
  }
  async function assetPickerFrame(mobile: boolean) {
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('#reference-picker-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)");
    assert.equal(await browser.evaluate(`(() => {
      const dialog = document.querySelector('#reference-picker-dialog'), rect = dialog.getBoundingClientRect();
      return dialog.matches(':modal') && Math.abs(rect.width - ${mobile ? 374 : 1040}) <= 1 && Math.abs(rect.height - 820) <= 1 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && dialog.scrollWidth <= dialog.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
    })()`), true, 'The asset picker fits its shared modal frame without horizontal overflow');
  }
  async function checkParameterHelp(label: string, meaning: RegExp, interaction: 'hover' | 'keyboard' | 'tap') {
    const selector = `button[aria-label="Help: ${label}"]`;
    const tooltip = `document.getElementById(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-describedby'))`;
    await browser.evaluate("Promise.all(document.querySelector('[aria-label=\"Advanced settings\"]:popover-open').getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)");
    const point = await browser.evaluate<{ x: number; y: number }>(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); button.scrollIntoView({block: 'nearest'}); const rect = button.getBoundingClientRect(); return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2}; })()`);
    const panelHeight = await browser.evaluate<number>("document.querySelector('[aria-label=\"Advanced settings\"]:popover-open').getBoundingClientRect().height");
    const tap = async () => { await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }); await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
    if (interaction === 'keyboard') {
      await browser.evaluate("document.querySelector('input[aria-label=\"Guidance value\"]').focus()");
      await browser.key('Tab');
      assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'), `Help: ${label}`, 'Help is reachable in the keyboard tab order');
    } else if (interaction === 'tap') await tap();
    else await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await browser.until(`(${tooltip})?.matches('[role=tooltip]:popover-open') && getComputedStyle(${tooltip}).visibility === 'visible'`, `${label} help opens by ${interaction}`);
    await browser.evaluate(`Promise.all([document.fonts.ready, ...(${tooltip}).getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)`);
    assert.match(await browser.evaluate<string>(`(${tooltip}).textContent`), meaning, `${label} explains the parameter's effect`);
    assert.equal(await browser.evaluate(`(() => { const rect = (${tooltip}).getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })()`), true, `${label} help remains visible within the viewport`);
    assert.equal(await browser.evaluate<number>("document.querySelector('[aria-label=\"Advanced settings\"]:popover-open').getBoundingClientRect().height"), panelHeight, 'Help does not resize Advanced');
    if (label === 'Width') await browser.screenshot(join(output, `parameter-help-${interaction === 'tap' ? 'mobile' : 'desktop'}.png`));
    if (interaction === 'tap') await tap(); else await browser.key('Escape');
    await browser.until(`!(${tooltip})?.matches(':popover-open')`, `${label} help closes`);
    assert.equal(await browser.evaluate("!!document.querySelector('[aria-label=\"Advanced settings\"]:popover-open')"), true, 'Dismissing help keeps Advanced open');
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  }
  await browser.navigate(`${origin}/image`);
  await browser.until("document.body.innerText.includes('Make this studio yours.')", 'Owner setup');
  await browser.fill('input[autocomplete="off"]', 'browser-integration-setup-key');
  await browser.fill('input[name="username"]', 'browser-owner');
  await browser.fill('input[name="password"]', 'test-password-strong-123');
  await browser.clickText('Create studio');
  await browser.until("document.querySelector('#settings-dialog[open]')?.innerText.includes('Set up your studio') && document.querySelectorAll('input[name=runtime-gpu]').length === 2", 'GPU onboarding dialog');
  await browser.evaluate("Promise.all(document.querySelector('#settings-dialog').getAnimations().map(animation => animation.finished.catch(() => {})))");
  assert.equal(await browser.evaluate("document.querySelector('#settings-dialog').matches(':modal') && !!document.querySelector('#image-prompt')"), true, 'Onboarding overlays the mounted Image workspace');
  assert.equal(await browser.evaluate("document.querySelectorAll('input[name=runtime-gpu]:checked').length"), 2, 'Detected GPUs are selected by default');
  assert.equal(await browser.evaluate("document.body.innerText.includes('0000:03:00.0') && document.body.innerText.includes('0000:07:00.0')"), true, 'Identical GPUs have visible PCI identities');
  assert.equal(await browser.evaluate("document.body.innerText.includes('Image models') || document.body.innerText.includes('pnpm runtime') || document.body.innerText.includes('GPU used by this worker')"), false, 'Onboarding exposes no terminal commands, worker mapping or model form');
  await browser.screenshot(join(output, 'setup-desktop.png'));
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.until('document.documentElement.clientWidth === 390', 'Mobile onboarding');
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
  await browser.screenshot(join(output, 'setup-mobile.png'));
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await browser.click('input[name="runtime-gpu"][value="amd:9700a"]');
  await clickScopedText('#settings-dialog', 'Set up generation');
  await browser.until("document.body.innerText.includes('Setting up…')", 'Automatic generation setup starts');
  await browser.until("document.body.innerText.includes('Generation is ready')", 'Automatic generation setup finishes');
  assert.deepEqual(chosenGpuIds, ['amd:9700b']);
  assert.deepEqual(store.settings().workers[0].deviceIds, ['amd:9700b']);
  assert.equal(store.settings().modelConfigurations.some(item => item.enabled), false, 'Setup does not choose models');
  await browser.clickText('Start creating');
  await browser.until("!document.querySelector('#settings-dialog[open]') && !!document.querySelector('#image-prompt')", 'Image composer after onboarding closes');
  await browser.clickText('Browse models');
  await browser.until("document.querySelector('#models-dialog[open]') && document.querySelector('#models-tab-library')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#models-panel-library article h3')", 'Models opens its Library section');
  assert.equal(await browser.evaluate("document.querySelector('#models-dialog').matches(':modal') && location.pathname === '/image'"), true, 'Gallery opens Models without navigating away');
  const modelSections = ['library', 'installed', 'huggingface', 'downloads'];
  assert.equal(await browser.evaluate("document.querySelector('[role=tablist][aria-label=\"Model sections\"]').getAttribute('aria-orientation')"), 'vertical');
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('[role=tablist][aria-label=\"Model sections\"] [role=tab]')).map(tab => tab.textContent.trim())"), ['Library', 'Installed', 'Hugging Face', 'Downloads']);
  async function modelSectionKey(key: string, section: string) {
    await browser.key(key);
    await browser.until(`document.querySelector('#models-tab-${section}')?.getAttribute('aria-selected') === 'true' && document.querySelector('#models-panel-${section}')?.getClientRects().length > 0`, `${key} opens Models ${section}`);
    assert.equal(await browser.evaluate('document.activeElement?.id'), `models-tab-${section}`, 'Models keyboard navigation focuses its selected tab');
    assert.equal(await browser.evaluate(`document.querySelector('#models-panel-${section}').getAttribute('aria-labelledby')`), `models-tab-${section}`);
  }
  async function modelFrame(mobile: boolean) {
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('#models-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)");
    const frame = await browser.evaluate<{ width: number; height: number; sidebar: number; fits: boolean }>(`(() => {
      const dialog = document.querySelector('#models-dialog'), rect = dialog.getBoundingClientRect(), sidebar = dialog.querySelector('[role=tablist][aria-label="Model sections"]').getBoundingClientRect();
      const selected = dialog.querySelector('[role=tab][aria-selected=true]'), panel = document.getElementById(selected.getAttribute('aria-controls'));
      return { width: rect.width, height: rect.height, sidebar: sidebar.width, fits: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1 && dialog.scrollWidth <= dialog.clientWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth && sidebar.right <= panel.getBoundingClientRect().left };
    })()`);
    assert.ok(Math.abs(frame.width - (mobile ? 374 : 1040)) <= 1, 'Models retains the shared modal width');
    assert.ok(Math.abs(frame.height - 820) <= 1, 'Models retains the shared modal height across sections');
    assert.ok(Math.abs(frame.sidebar - (mobile ? 56 : 200)) <= 1, 'Models keeps its left navigation beside the content');
    assert.equal(frame.fits, true, 'The selected Models section fits the viewport without horizontal overflow');
  }
  await browser.click('#models-tab-library');
  await modelFrame(false);
  await modelSectionKey('ArrowDown', 'installed');
  assert.equal(await browser.evaluate("document.querySelectorAll('#models-panel-installed article').length"), 0, 'Installed excludes every checkpoint before the first download');
  await modelFrame(false);
  await modelSectionKey('ArrowDown', 'huggingface');
  await browser.fill('input[name="checkpoint-url"]', checkpointUrl);
  await browser.fill('input[name="checkpoint-name"]', 'Browser checkpoint');
  await modelFrame(false);
  await modelSectionKey('ArrowDown', 'downloads');
  await modelFrame(false);
  await modelSectionKey('Home', 'library');
  await modelSectionKey('End', 'downloads');
  await modelSectionKey('ArrowUp', 'huggingface');
  assert.equal(await browser.evaluate("document.querySelector('input[name=checkpoint-url]').value"), checkpointUrl, 'Switching sections preserves the Hugging Face URL draft');
  assert.equal(await browser.evaluate("document.querySelector('input[name=checkpoint-name]').value"), 'Browser checkpoint', 'Switching sections preserves the checkpoint name draft');
  await browser.clickText('Download checkpoint');
  await browser.until("document.querySelector('#models-tab-downloads')?.getAttribute('aria-selected') === 'true' && document.activeElement?.id === 'models-tab-downloads' && !!document.querySelector('#models-panel-downloads progress')", 'Starting a download opens and focuses Downloads');
  await browser.click('#models-tab-library');
  await clickScopedText('#models-dialog', 'View download');
  await browser.until("!!document.querySelector('#models-panel-downloads progress')", 'Download progress survives switching sections');
  await browser.click('button[aria-label="Close models"]');
  await browser.until("!document.querySelector('#models-dialog[open]')", 'Close Models while its download is pending');
  await browser.click('header button[aria-label="Models"]');
  await browser.until("document.querySelector('#models-dialog[open]') && document.querySelector('#models-tab-library')?.getAttribute('aria-selected') === 'true'", 'Reopening Models starts in Library');
  await clickScopedText('#models-dialog', 'View download');
  await browser.until("document.querySelector('#models-tab-downloads')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#models-panel-downloads progress')", 'Reopened Models links to its ongoing download');
  await browser.click('#models-tab-library');
  await browser.click('button[aria-label="Close models"]');
  await browser.until("!document.querySelector('#models-dialog[open]')", 'Download continues after closing Models');
  finishCheckpointDownload();
  await browser.until("!!document.querySelector('main button[aria-label=\"Model: Browser checkpoint\"]')", 'Background download refreshes the Image model selection');
  assert.equal(store.settings().modelConfigurations.find(item => item.modelId === modelId)?.enabled, true);
  assert.deepEqual(store.settings().modelConfigurations.find(item => item.modelId === modelId)?.workerIds, ['browser-comfy']);
  await browser.click('header button[aria-label="Models"]');
  await browser.until("document.querySelector('#models-dialog[open]') && document.querySelector('#models-panel-library')?.innerText.includes('Ready to use')", 'Downloaded checkpoint is activated when Models reopens');
  await browser.click('#models-tab-downloads');
  await browser.until("document.querySelector('#models-panel-downloads')?.innerText.includes('Ready to generate') && !document.querySelector('#models-panel-downloads progress')", 'Downloads records completion while another section was selected');
  await browser.click('#models-tab-installed');
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('#models-panel-installed article h3')).map(heading => heading.textContent.trim())"), ['Browser checkpoint'], 'Installed contains only the downloaded model');
  await browser.evaluate("document.querySelectorAll('#models-dialog, #models-dialog *').forEach(element => { if (getComputedStyle(element).overflowY === 'auto') element.scrollTop = 0; })");
  await browser.screenshot(join(output, 'models-desktop.png'));
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const section of modelSections) {
    await browser.click(`#models-tab-${section}`);
    await modelFrame(true);
    await browser.screenshot(join(output, `models-${section}-mobile.png`));
  }
  await browser.click('#models-tab-installed');
  await browser.screenshot(join(output, 'models-mobile.png'));
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await browser.click('button[aria-label="Close models"]');
  await browser.until("!document.querySelector('#models-dialog[open]')", 'Model library closes after import');
  await browser.until("!!document.querySelector('button[aria-label=\"Model: Browser checkpoint\"]')", 'Ready model');
  await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'idle'", 'Server activity starts idle');
  assert.equal(await browser.evaluate("document.querySelector('[data-server-activity]').textContent.includes('Activity')"), false, 'The header uses a compact meter without an Activity text label');
  const prompt = 'A cinematic forest in the morning mist';
  await browser.fill('#image-prompt', prompt);
  const advertised = await browser.evaluate<{ defaults: { width: number; height: number; steps: number; cfg: number }; dimensions: { multiple: number; min: number; max: number; maxPixels: number }; capabilities: { negativePrompt: boolean } }>(`fetch('/api/catalog').then(response => response.json()).then(catalog => catalog.models.find(model => model.id === ${JSON.stringify(modelId)}))`);
  assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Reset settings to defaults\"]').disabled"), true, 'Reset is disabled when generation settings match the selected model');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('main button')).some(button => /^\\d+ steps$/.test(button.textContent.trim()))"), false, 'Sampling steps live in Advanced rather than a separate toolbar chip');
  await browser.click('button[aria-label="Model: Browser checkpoint"]');
  await browser.until("!!document.querySelector('[popover]:popover-open [role=menuitem][aria-current=true]')", 'Selected model row');
  assert.equal(await browser.evaluate("!!document.querySelector('[popover]:popover-open input[aria-label=\"Search models\"]')"), false, 'A short model list needs no search field');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('[popover]:popover-open [role=menuitem]')).some(row => row.textContent.includes('SDXL Base 1.0'))"), false, 'A model without installed files is absent from the composer menu');
  await browser.click('button[aria-label="Manage image models"]');
  await browser.until("!!document.querySelector('#models-dialog[open]') && !document.querySelector('[popover]:popover-open')", 'Model menu opens its management modal');
  await browser.click('button[aria-label="Close models"]');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), prompt, 'Managing models preserves the prompt');
  await browser.click('button[aria-label^="Aspect ratio:"]');
  await browser.until("!!document.querySelector('[popover]:popover-open [aria-label=\"Aspect ratio 16:9\"]')", 'Aspect ratio menu');
  await screenshotPopover('ratios-desktop.png');
  await browser.click('[popover]:popover-open [aria-label="Aspect ratio 16:9"]');
  await browser.until("!!document.querySelector('button[aria-label=\"Aspect ratio: 16:9\"]') && !document.querySelector('[popover]:popover-open')", 'Pointer chooses a widescreen aspect');
  await openAdvanced();
  const widescreen = await browser.evaluate<{ width: number; height: number }>("({width: Number(document.querySelector('input[aria-label=\"Width value\"]').value), height: Number(document.querySelector('input[aria-label=\"Height value\"]').value)})");
  assert.ok(widescreen.width > widescreen.height && Math.abs(widescreen.width / widescreen.height - 16 / 9) < .06, 'Widescreen dimensions approximate the requested ratio');
  for (const side of [widescreen.width, widescreen.height]) assert.ok(side >= advertised.dimensions.min && side <= advertised.dimensions.max && side % advertised.dimensions.multiple === 0);
  assert.ok(widescreen.width * widescreen.height <= advertised.dimensions.maxPixels, 'Aspect choices stay within the advertised pixel budget');
  assert.equal(await browser.evaluate("!!document.querySelector('[popover]:popover-open input[aria-label=\"Image strength value\"]')"), false, 'Text-to-image has no image-strength control');
  await browser.key('Escape');
  await browser.click('button[aria-label^="Aspect ratio:"]');
  await browser.until("document.activeElement?.getAttribute('role') === 'menuitem' && !!document.activeElement.closest('[popover]:popover-open')", 'Aspect menu receives keyboard focus');
  await browser.key('Home');
  assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'), 'Aspect ratio Auto', 'Home focuses the first aspect choice');
  await browser.key('Enter');
  await browser.until("!!document.querySelector('button[aria-label=\"Aspect ratio: Auto\"]') && !document.querySelector('[popover]:popover-open')", 'Keyboard chooses the default aspect');
  await openAdvanced();
  assert.deepEqual(await browser.evaluate("({width: Number(document.querySelector('input[aria-label=\"Width value\"]').value), height: Number(document.querySelector('input[aria-label=\"Height value\"]').value)})"), { width: advertised.defaults.width, height: advertised.defaults.height });
  await browser.fill('input[aria-label="Steps value"]', '24');
  assert.equal(await browser.evaluate("document.querySelector('input[type=range][aria-label=Steps]').value"), '24', 'Steps number field updates its slider');
  await browser.fill('input[type="range"][aria-label="Guidance"]', '6.5');
  assert.equal(await browser.evaluate("document.querySelector('input[aria-label=\"Guidance value\"]').value"), '6.5', 'Guidance slider updates its number field');
  await browser.evaluate("document.querySelector('input[type=range][aria-label=Width]').focus()");
  assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'), 'Width', 'Width slider receives keyboard focus');
  await browser.key('ArrowRight');
  const generationWidth = advertised.defaults.width + advertised.dimensions.multiple;
  assert.equal(await browser.evaluate("Number(document.querySelector('input[aria-label=\"Width value\"]').value)"), generationWidth, 'Keyboard slider changes width by the model grid');
  await browser.fill('input[aria-label="Height value"]', '768');
  assert.equal(await browser.evaluate("document.querySelector('input[type=range][aria-label=Height]').value"), '768', 'Height number field updates its slider');
  await browser.fill('input[aria-label="Seed"]', '1234');
  await browser.click('button[aria-label="Randomise seed"]');
  const randomized = await browser.evaluate<string>("document.querySelector('input[aria-label=Seed]').value");
  assert.ok(/^\d+$/.test(randomized) && Number(randomized) >= 0 && Number(randomized) <= 0xffffffff && randomized !== '1234', 'Shuffle sets a fresh valid seed');
  await browser.fill('input[aria-label="Seed"]', '1234');
  assert.equal(advertised.capabilities.negativePrompt, true);
  await browser.fill('[popover]:popover-open textarea', 'text, watermark');
  await browser.evaluate("document.querySelectorAll('[popover]:popover-open *').forEach(element => { if (getComputedStyle(element).overflowY === 'auto') element.scrollTop = 0; })");
  await screenshotPopover('advanced-desktop.png');
  await browser.key('Escape');
  await browser.until("!document.querySelector('[popover]:popover-open')", 'Escape dismisses advanced');
  assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'), 'Advanced settings');
  completeAutomatically = false;
  await browser.clickText('Generate');
  await browser.until("['queued', 'running'].includes(document.querySelector('[data-server-activity]')?.dataset.state)", 'Server activity reflects the pending generation');
  completeAutomatically = true;
  await browser.until("!!document.querySelector('button[aria-label=\"Open Browser checkpoint output\"]')", 'Generated output in gallery');
  await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'idle'", 'Server activity returns to idle after generation');
  const first = store.jobs(store.owner()!.id)[0];
  assert.equal(first.status, 'succeeded'); assert.equal(first.parameters.seed, 1234); assert.equal(comfy.state.submissions.length, 1);
  assert.deepEqual({ width: first.parameters.width, height: first.parameters.height, steps: first.parameters.steps, cfg: first.parameters.cfg, negativePrompt: first.parameters.negativePrompt }, { width: generationWidth, height: 768, steps: 24, cfg: 6.5, negativePrompt: 'text, watermark' }, 'Generation uses the edited toolbar parameters');
  await browser.until("Array.from(document.querySelectorAll('figure img')).every(image => image.complete && image.naturalWidth > 0)", 'Output image pixels loaded');
  await browser.screenshot(join(output, 'image-desktop.png'));
  await browser.fill('#image-prompt', 'Temporary draft');
  await browser.click('[aria-label="Use these settings"]');
  await browser.until(`document.querySelector('#image-prompt').value === ${JSON.stringify(prompt)}`, 'Restore accepted prompt');
  await uploadReference();
  assert.equal(await browser.evaluate("document.querySelector('input[aria-label=\"Upload reference images\"]').disabled && document.querySelector('button[aria-label=\"Add reference image\"]').disabled && document.querySelector('button[aria-label=\"Browse saved images\"]').disabled"), true, 'The single-reference model keeps both reference controls visible and prevents a second upload');
  await browser.fill('#image-prompt', 'Keep the composition and turn morning into twilight');
  await openAdvanced();
  for (const [label, meaning] of [
    ['Width', /pixels/i], ['Height', /pixels/i], ['Steps', /more|longer/i],
    ['Guidance', /prompt/i], ['Seed', /random/i], ['Image strength', /reference|original/i], ['Negative prompt', /avoid/i],
  ] as const) await checkParameterHelp(label, meaning, label === 'Seed' ? 'keyboard' : 'hover');
  await browser.fill('input[aria-label="Image strength value"]', '.45');
  assert.equal(await browser.evaluate("document.querySelector('input[type=range][aria-label=\"Image strength\"]').value"), '0.45', 'Image strength stays synchronized with its slider');
  await browser.key('Escape');
  await browser.evaluate("void (window.__gravityResetReference = document.querySelector('button[aria-label=\"Remove reference 1\"]'))");
  await browser.click('button[aria-label="Reset settings to defaults"]');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), 'Keep the composition and turn morning into twilight', 'Reset preserves the prompt');
  assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Remove reference 1\"]') === window.__gravityResetReference"), true, 'Reset preserves the selected reference');
  assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Reset settings to defaults\"]').disabled"), true, 'Reset becomes disabled after restoring defaults');
  await openAdvanced();
  const resetValues = await browser.evaluate("({ width: Number(document.querySelector('input[aria-label=\"Width value\"]').value), height: Number(document.querySelector('input[aria-label=\"Height value\"]').value), steps: Number(document.querySelector('input[aria-label=\"Steps value\"]').value), cfg: Number(document.querySelector('input[aria-label=\"Guidance value\"]').value), seed: document.querySelector('input[aria-label=Seed]').value, negativePrompt: document.querySelector('[popover]:popover-open textarea').value, denoise: Number(document.querySelector('input[aria-label=\"Image strength value\"]').value) })");
  assert.deepEqual(resetValues, { width: advertised.defaults.width, height: advertised.defaults.height, steps: advertised.defaults.steps, cfg: advertised.defaults.cfg, seed: '', negativePrompt: '', denoise: .75 });
  await browser.fill('input[aria-label="Width value"]', '2048');
  assert.ok(await browser.evaluate<number>("Number(document.querySelector('input[type=range][aria-label=Height]').max)") * 2048 <= advertised.dimensions.maxPixels, 'Slider maximum respects the shared pixel budget');
  await browser.fill('input[aria-label="Height value"]', '2048');
  await browser.until("document.querySelector('main [role=alert]')?.textContent.includes('pixels')", 'An oversized typed image receives a visible explanation');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('main button')).find(button => button.textContent.trim() === 'Generate').disabled"), true, 'Generation is blocked for a manually entered size above the pixel budget');
  await browser.key('Escape');
  await browser.click('button[aria-label="Reset settings to defaults"]');
  await browser.until("!document.querySelector('main [role=alert]') && !Array.from(document.querySelectorAll('main button')).find(button => button.textContent.trim() === 'Generate').disabled", 'Reset restores a valid, generatable image size');
  assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Remove reference 1\"]') === window.__gravityResetReference"), true, 'Recovery from invalid dimensions keeps the reference');
  await browser.click('button[aria-label="Remove reference 1"]');
  await browser.until("document.querySelector('button[aria-label=\"Browse saved images\"]')?.disabled === false", 'Removing a reference makes upload and saved-image selection available');
  await browser.click('[aria-label="Browse saved images"]');
  await browser.until("document.querySelector('#reference-picker-dialog[open]')?.matches(':modal')", 'Reference picker opens');
  await browser.until("document.querySelectorAll('#reference-picker-dialog article[data-asset-id]').length === 2", 'Picker loads the generated output and previous import');
  assert.match(await browser.evaluate<string>("document.querySelector('#reference-picker-dialog nav[aria-label=\"Asset categories\"] button[aria-current=page]').textContent"), /^Image/);
  assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog').textContent.includes('Imported images')"), true, 'Undated inputs have an Imported images group');
  const generatedAsset = '#reference-picker-dialog article[data-source="generated"] button[aria-pressed]';
  const importedAsset = '#reference-picker-dialog article[data-source="import"] button[aria-pressed]';
  await browser.click(generatedAsset);
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', 'no-assets-match-this-query');
  await browser.until("!document.querySelector('#reference-picker-dialog article[data-asset-id]') && document.querySelector('#reference-picker-dialog').innerText.includes('No matching assets')", 'Search shows an explicit empty state');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#reference-picker-dialog button')).find(button => button.textContent.trim() === 'Use selected').disabled"), false, 'A selection survives being hidden by search');
  await browser.screenshot(join(output, 'assets-picker-empty-desktop.png'));
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', '');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(generatedAsset)}).getAttribute('aria-pressed')`), 'true', 'Clearing search restores the selected output');
  await assetCategory('Imports');
  assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog article[data-source=import]').length === 1 && !document.querySelector('#reference-picker-dialog article[data-source=generated]')"), true, 'Imports filters out generated images');
  await browser.click(importedAsset);
  await assetCategory('All Assets');
  assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]').length"), 1, 'A single-reference model replaces the previous selection');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(importedAsset)}).getAttribute('aria-pressed')`), 'true');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(generatedAsset)}).getAttribute('aria-pressed')`), 'false');
  await browser.click(generatedAsset);
  await assetCategory('Image');
  await assetPickerFrame(false);
  await browser.screenshot(join(output, 'assets-picker-desktop.png'));
  await clickScopedText('#reference-picker-dialog', 'Use selected');
  await browser.until("!document.querySelector('#reference-picker-dialog[open]') && !!document.querySelector('button[aria-label=\"Remove reference 1\"]')", 'Reference is uploaded');
  await browser.fill('#image-prompt', 'Keep the composition and turn morning into twilight');
  await browser.clickText('Generate');
  await browser.until("document.querySelectorAll('button[aria-label=\"Open Browser checkpoint output\"]').length === 2", 'Reference generation completes');
  assert.equal(store.jobs(store.owner()!.id)[0].input.operation, 'image-to-image');
  assert.ok(comfy.state.uploadBody.includes('filename='));
  await browser.send('Page.reload');
  await browser.until("document.querySelectorAll('button[aria-label=\"Open Browser checkpoint output\"]').length === 2", 'Durable gallery after reload');
  await browser.until("document.querySelector('#image-prompt')?.value.includes('twilight') && !!document.querySelector('button[aria-label=\"Remove reference 1\"]')", 'Draft and references persist after reload');
  await browser.evaluate("void (window.__gravityViewerState = { opener: document.querySelector('button[aria-label=\"Open Browser checkpoint output\"]'), prompt: document.querySelector('#image-prompt').value, reference: document.querySelector('button[aria-label=\"Remove reference 1\"]') })");
  await browser.click('[aria-label="Open Browser checkpoint output"]');
  await browser.until("document.querySelector('dialog[open][aria-label=\"Browser checkpoint output\"]')?.matches(':modal') && document.querySelector('[aria-label=\"Image zoom and pan\"] img')?.naturalWidth > 0", 'Output viewer opens with the image loaded');
  assert.equal(await browser.evaluate("document.activeElement === document.querySelector('dialog[open]')"), true, 'The viewer initially focuses its frame instead of an action');
  const viewedSource = await browser.evaluate<string>("document.querySelector('[aria-label=\"Image zoom and pan\"] img').src");
  assert.equal(await browser.evaluate("document.querySelector('dialog[open] aside').innerText.includes('1 of 2')"), true, 'The viewer follows the gallery order');
  await browser.screenshot(join(output, 'output-viewer-desktop.png'));
  await browser.key('ArrowRight');
  await browser.until(`document.querySelector('[aria-label="Image zoom and pan"] img')?.src !== ${JSON.stringify(viewedSource)} && document.querySelector('dialog[open] aside').innerText.includes('2 of 2')`, 'ArrowRight moves to the next output');
  assert.equal(await browser.evaluate(`document.querySelector('dialog[open] aside').innerText.includes(${JSON.stringify(prompt)})`), true, 'The details follow the selected output prompt');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('dialog[open] dt')).find(label => label.textContent === 'Seed')?.nextElementSibling.textContent"), '1234', 'The viewer displays the selected generation seed');
  await browser.click('dialog[open] button[aria-label="Previous output"]');
  await browser.until(`document.querySelector('[aria-label="Image zoom and pan"] img')?.src === ${JSON.stringify(viewedSource)} && document.querySelector('button[aria-label="Zoom in"]')?.disabled === false`, 'Previous returns to the original image');
  await browser.click('button[aria-label="Zoom in"]');
  await browser.until("document.querySelector('[aria-label=\"Zoom level\"]')?.textContent === '150%' && document.querySelector('[aria-label=\"Image zoom and pan\"]')?.dataset.zoomed === 'true'", 'Zoom enlarges the image');
  await browser.evaluate("document.querySelector('[aria-label=\"Image zoom and pan\"]').focus()");
  const panTop = await browser.evaluate<number>("document.querySelector('[aria-label=\"Image zoom and pan\"]').scrollTop");
  await browser.key('ArrowDown');
  await browser.until(`document.querySelector('[aria-label="Image zoom and pan"]').scrollTop > ${panTop}`, 'ArrowDown pans the enlarged image');
  assert.equal(await browser.evaluate<string>("document.querySelector('[aria-label=\"Image zoom and pan\"] img').src"), viewedSource, 'Panning does not navigate to a different output');
  await browser.key('Escape');
  await browser.until("!!document.querySelector('dialog[open]') && document.querySelector('[aria-label=\"Zoom level\"]')?.textContent === 'Fit'", 'First Escape restores fit without closing the enlarged image');
  await browser.key('Escape');
  await browser.until("!document.querySelector('dialog[open]')", 'Output viewer Escape closes');
  assert.equal(await browser.evaluate('document.activeElement === window.__gravityViewerState.opener'), true, 'Closing the viewer restores focus to the opened gallery output');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value === window.__gravityViewerState.prompt && document.querySelector('button[aria-label=\"Remove reference 1\"]') === window.__gravityViewerState.reference"), true, 'Browsing and zooming preserve the unfinished prompt and reference');

  // Keep a genuine scrolled gallery and a live draft beneath both overlays.
  // DOM identity catches remounts that restoring localStorage alone would conceal.
  const modalDraft = 'Keep this unfinished prompt while browsing my models and settings';
  await browser.fill('#image-prompt', modalDraft);
  await browser.fill('input[aria-label="Image tile size"]', '1');
  async function checkWorkspaceModal(label: 'Models' | 'Settings', closeWith: 'escape' | 'backdrop', viewport: string) {
    const id = `${label.toLowerCase()}-dialog`;
    const trigger = `header button[aria-label="${label}"]`;
    const findGallery = "(() => { let element = document.querySelector('figure'); while (element && element !== document.body) { if (['auto', 'scroll'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight) return element; element = element.parentElement; } return null; })()";
    await browser.until(`!!(${findGallery})`, `${viewport} gallery has actual overflow`);
    await browser.evaluate(`(() => { const gallery = (${findGallery}); gallery.scrollTop = Math.min(120, gallery.scrollHeight - gallery.clientHeight); window.__gravityModalState = { prompt: document.querySelector('#image-prompt'), value: document.querySelector('#image-prompt').value, gallery, scrollTop: gallery.scrollTop, trigger: document.querySelector(${JSON.stringify(trigger)}), reference: document.querySelector('button[aria-label="Remove reference 1"]') }; })()`);
    assert.equal(await browser.evaluate('window.__gravityModalState.scrollTop > 0'), true, 'The preservation check uses a nonzero scroll position');
    const workspaceWidth = await browser.evaluate<number>("document.querySelector('main').getBoundingClientRect().width");
    assert.equal(await browser.evaluate('document.querySelector("main").getBoundingClientRect().width >= innerWidth - 2'), true, 'Image workspace uses the full viewport width');
    await browser.click(trigger);
    await browser.until(`document.querySelector('#${id}[open]')?.matches(':modal')`, `${label} opens as a native modal`);
    await browser.until(`Array.from(document.querySelectorAll('#${id} h1, #${id} h2')).some(heading => heading.textContent.trim() === ${JSON.stringify(label)})`, `${label} modal heading`);
    await browser.evaluate(`Promise.all(document.querySelector('#${id}').getAnimations().map(animation => animation.finished.catch(() => {})))`);
    assert.equal(await browser.evaluate(`(() => { const dialog = document.querySelector('#${id}'); const rect = dialog.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && dialog.scrollWidth <= dialog.clientWidth + 1; })()`), true, `${viewport} ${label} fits the viewport without horizontal overflow`);
    assert.equal(await browser.evaluate<number>("document.querySelector('main').getBoundingClientRect().width"), workspaceWidth, 'Opening an overlay does not narrow the Image workspace');
    assert.equal(await browser.evaluate("document.querySelector('#image-prompt') === window.__gravityModalState.prompt && window.__gravityModalState.gallery.isConnected"), true, 'Composer and gallery remain mounted behind the dialog');
    assert.equal(await browser.evaluate<string>("document.querySelector('#image-prompt').value"), modalDraft);
    const focusables = `Array.from(document.querySelectorAll('#${id} button, #${id} a[href], #${id} input, #${id} select, #${id} textarea, #${id} summary, #${id} [tabindex]')).filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length && getComputedStyle(element).visibility === 'visible')`;
    await browser.evaluate(`(${focusables}).at(-1).focus()`);
    await browser.key('Tab');
    assert.equal(await browser.evaluate(`document.querySelector('#${id}').contains(document.activeElement)`), true, `Tab stays inside the modal; focused ${await browser.evaluate('document.activeElement?.outerHTML.slice(0, 200)')}`);
    await browser.evaluate(`(${focusables})[0].focus()`);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 1 });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 1 });
    assert.equal(await browser.evaluate(`document.querySelector('#${id}').contains(document.activeElement)`), true, 'Shift+Tab stays inside the modal');
    await browser.evaluate("document.querySelector('#image-prompt').focus()");
    assert.equal(await browser.evaluate(`document.querySelector('#${id}').contains(document.activeElement)`), true, 'The underlying composer is inert while the dialog is open');
    await browser.screenshot(join(output, `${label.toLowerCase()}-modal-${viewport}.png`));
    if (closeWith === 'escape') await browser.key('Escape');
    else {
      const point = await browser.evaluate<{ x: number; y: number } | null>(`(() => { const rect = document.querySelector('#${id}').getBoundingClientRect(); return [{x: 2, y: 2}, {x: innerWidth - 2, y: 2}, {x: 2, y: innerHeight - 2}, {x: innerWidth - 2, y: innerHeight - 2}].find(point => point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) || null; })()`);
      assert.ok(point, 'The modal leaves a clickable backdrop');
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
    await browser.until(`!document.querySelector('#${id}[open]')`, `${label} closes by ${closeWith}`);
    assert.equal(await browser.evaluate('document.activeElement === window.__gravityModalState.trigger'), true, 'Focus returns to the opener');
    assert.equal(await browser.evaluate("document.querySelector('#image-prompt') === window.__gravityModalState.prompt && document.querySelector('#image-prompt').value === window.__gravityModalState.value"), true, 'The same composer retains the unfinished draft');
    assert.equal(await browser.evaluate('window.__gravityModalState.gallery.isConnected && window.__gravityModalState.gallery.scrollTop === window.__gravityModalState.scrollTop'), true, 'The same gallery retains its scroll position');
    assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Remove reference 1\"]') === window.__gravityModalState.reference"), true, 'Selected reference remains mounted');
    assert.equal(await browser.evaluate('location.pathname'), '/image', 'Opening and closing dialogs does not navigate away');
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 700, deviceScaleFactor: 1, mobile: false });
  await checkWorkspaceModal('Models', 'escape', 'desktop');
  await checkWorkspaceModal('Settings', 'backdrop', 'desktop');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.until('document.documentElement.clientWidth === 390', 'Mobile viewport');
  await browser.click('[aria-label="Open Browser checkpoint output"]');
  await browser.until("document.querySelector('dialog[open] aside')?.innerText.includes('1 of 2')", 'Mobile output viewer opens');
  await browser.click('dialog[open] button[aria-label="Next output"]');
  await browser.until("document.querySelector('dialog[open] aside')?.innerText.includes('2 of 2') && document.querySelector('[aria-label=\"Image zoom and pan\"] img')?.naturalWidth > 0", 'Mobile next action changes the output');
  await browser.screenshot(join(output, 'output-viewer-mobile.png'));
  await browser.click('dialog[open] button[aria-label="Close preview"]');
  await browser.until("!document.querySelector('dialog[open]')", 'Mobile preview closes from its visible action');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), modalDraft, 'Mobile viewing preserves the unfinished draft');
  await checkWorkspaceModal('Models', 'backdrop', 'mobile');
  await checkWorkspaceModal('Settings', 'escape', 'mobile');
  await browser.click('button[aria-label="Remove reference 1"]');
  await browser.until("document.querySelector('button[aria-label=\"Add reference image\"]')?.disabled === false", 'Mobile upload control is available after removing a reference');
  for (const label of ['Add reference image', 'Browse saved images']) {
    assert.equal(await browser.evaluate(`(() => { const rect = document.querySelector('button[aria-label=${JSON.stringify(label)}]').getBoundingClientRect(); return rect.width >= 40 && rect.height >= 40 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`), true, `${label} remains reachable on mobile`);
  }
  const importsBeforeCancel = store.inputs(store.owner()!.id).length;
  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("!!document.querySelector('#reference-picker-dialog[open] article[data-source=import]')", 'Mobile asset picker loads saved imports');
  await browser.click(generatedAsset);
  await assetPickerFrame(true);
  await browser.screenshot(join(output, 'assets-picker-mobile.png'));
  await clickScopedText('#reference-picker-dialog', 'Cancel');
  await browser.until("!document.querySelector('#reference-picker-dialog[open]') && document.activeElement?.getAttribute('aria-label') === 'Browse saved images'", 'Cancel returns focus to Browse saved images');
  assert.equal(store.inputs(store.owner()!.id).length, importsBeforeCancel, 'Cancel does not upload a selected asset');
  assert.equal(await browser.evaluate("!!document.querySelector('button[aria-label=\"Remove reference 1\"]')"), false, 'Cancel leaves the composer references unchanged');
  await uploadReference();
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), modalDraft, 'Mobile upload preserves the unfinished prompt');
  await browser.click('button[aria-label^="Aspect ratio:"]');
  await browser.until("!!document.querySelector('[popover]:popover-open [aria-label=\"Aspect ratio 3:4\"]')", 'Mobile aspect menu');
  assert.equal(await browser.evaluate("(() => { const menu = document.querySelector('[popover]:popover-open'); const rect = menu.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && menu.scrollWidth <= menu.clientWidth; })()"), true, 'Aspect menu fits the mobile viewport');
  await screenshotPopover('ratios-mobile.png');
  await browser.click('[popover]:popover-open [aria-label="Aspect ratio 3:4"]');
  await openAdvanced();
  assert.equal(await browser.evaluate("(() => { const menu = document.querySelector('[aria-label=\"Advanced settings\"]:popover-open'); const rect = menu.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && menu.scrollWidth <= menu.clientWidth; })()"), true, 'Advanced controls fit the mobile viewport');
  await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try { await checkParameterHelp('Width', /pixels/i, 'tap'); }
  finally { await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false }); }
  assert.equal(await browser.evaluate("Number(document.querySelector('input[aria-label=\"Height value\"]').value) > Number(document.querySelector('input[aria-label=\"Width value\"]').value)"), true, 'Mobile portrait choice updates dimensions');
  await screenshotPopover('advanced-mobile.png');
  await browser.key('Escape');
  await browser.click('button[aria-label="Reset settings to defaults"]');
  assert.equal(await browser.evaluate("!!document.querySelector('button[aria-label=\"Remove reference 1\"]') && document.querySelector('#image-prompt').value === window.__gravityModalState.value"), true, 'Mobile reset keeps the uploaded reference and prompt');
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'Mobile page must not overflow horizontally');
  assert.equal(await browser.evaluate("(() => { const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Generate'); const rect = button.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44 && rect.bottom <= innerHeight; })()"), true, 'Generate remains reachable on mobile');
  await browser.until("(() => { const input = document.querySelector('#image-prompt'); return input.scrollHeight <= input.clientHeight + 2; })()", 'Mobile prompt fits its wrapped text');
  await browser.screenshot(join(output, 'image-mobile.png'));
  comfy.state.postBehavior = 'drop-before-accept';
  await browser.clickText('Generate');
  await browser.until("document.body.innerText.includes('Close unknown job')", 'Uncertain generation offers owner resolution');
  await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'attention'", 'Unknown generation is visible in the server activity meter');
  const unknown = store.jobs(store.owner()!.id)[0];
  assert.equal(unknown.status, 'interrupted');
  const declined = browser.answerNextDialog(false);
  await clickScopedText('main', 'Close unknown job');
  assert.match(await declined, /recheck.*queue and history/);
  assert.equal(store.job(unknown.id).status, 'interrupted', 'Dismissing confirmation keeps the resource reservation');
  const accepted = browser.answerNextDialog(true);
  await clickScopedText('main', 'Close unknown job');
  await accepted;
  await browser.until("document.body.innerText.includes('Closed by owner')", 'Owner closes the absent generation');
  assert.equal(store.job(unknown.id).status, 'failed');
  assert.equal(comfy.state.submissions.filter(item => item.prompt_id === unknown.id).length, 1, 'Closing does not resubmit');
  await browser.click('header button[aria-label="Settings"]');
  await browser.until("document.querySelector('#settings-dialog[open]')?.innerText.includes('GPUs to use')", 'Mobile settings dialog');
  await browser.click('input[name="runtime-gpu"][value="amd:9700a"]');
  await clickScopedText('#settings-dialog', 'Apply GPU selection');
  await browser.until("document.querySelector('#settings-dialog')?.innerText.includes('2 GPUs ready for generation')", 'Both selected GPUs are ready');
  assert.deepEqual(store.settings().workers.map(worker => worker.enabled), [true, true]);
  assert.deepEqual(store.settings().modelConfigurations.find(configuration => configuration.modelId === modelId)?.workerIds, ['browser-comfy', 'browser-comfy-first']);
  const savedPolicy = structuredClone(store.settings().policy);
  await browser.screenshot(join(output, 'settings-mobile.png'));
  assert.equal(await browser.evaluate("document.querySelector('[role=tablist][aria-label=\"Settings sections\"]')?.getAttribute('aria-orientation')"), 'vertical', 'Settings has one vertical section navigator');
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('[role=tablist][aria-label=\"Settings sections\"] [role=tab]')).map(tab => tab.textContent.trim())"), ['GPUs', 'Generation', 'Connections', 'Model files', 'API access']);
  async function settingsKey(key: string, section: string) {
    await browser.key(key);
    await browser.until(`document.querySelector('#settings-tab-${section}')?.getAttribute('aria-selected') === 'true' && document.querySelector('#settings-panel-${section}')?.hidden === false`, `${key} selects the ${section} section`);
    assert.equal(await browser.evaluate('document.activeElement?.id'), `settings-tab-${section}`, 'Keyboard navigation moves focus with the selected tab');
    assert.equal(await browser.evaluate(`document.querySelector('#settings-panel-${section}').getAttribute('aria-labelledby')`), `settings-tab-${section}`, 'The selected panel is labelled by its tab');
  }
  await browser.click('#settings-tab-gpus');
  await settingsKey('ArrowDown', 'generation');
  await browser.fill('#settings-panel-generation input[name="ramReserveGiB"]', '9');
  await browser.fill('#settings-panel-generation input[name="vramReserveGiB"]', '1.5');
  await browser.fill('#settings-panel-generation input[name="maxConcurrentJobs"]', '1');
  await browser.fill('#settings-panel-generation select[name="idleUnloadSeconds"]', '300');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation').textContent.includes('Keep models ready')"), true, 'Retention is controlled in Generation');
  await settingsKey('ArrowDown', 'connections');
  const workerNameInput = '#settings-panel-connections input[maxlength="80"]';
  await browser.until("document.querySelector('#settings-panel-connections')?.innerText.includes('Assigned GPU')", 'Managed worker shows its assigned GPU');
  assert.equal(await browser.evaluate("!!document.querySelector('#settings-panel-connections input[name=worker-gpu]')"), false, 'Managed worker GPU assignment cannot be remapped with a radio');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-connections input[type=url]').readOnly"), true, 'Managed endpoint is read-only');
  assert.equal(await browser.evaluate("(() => { const label = Array.from(document.querySelectorAll('#settings-panel-connections label')).find(label => label.textContent.startsWith('Worker location')); const control = label?.querySelector('input,select'); return !!control && (control.readOnly || control.disabled); })()"), true, 'Managed worker location is read-only');
  assert.equal(await browser.evaluate("!!document.querySelector('#settings-panel-connections input[type=checkbox], #settings-panel-connections button[aria-label=\"Remove selected worker\"]')"), false, 'Managed enable and remove controls are absent');
  await clickScopedText('#settings-panel-connections', 'Choose GPUs');
  await browser.until("document.querySelector('#settings-tab-gpus')?.getAttribute('aria-selected') === 'true'", 'Managed connection links to the shared GPU checkboxes');
  assert.equal(await browser.evaluate("document.querySelectorAll('input[name=runtime-gpu]:checked').length"), 2);
  await browser.click('input[name="runtime-gpu"][value="amd:9700a"]');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#settings-panel-gpus button')).find(button => button.textContent.trim() === 'Apply GPU selection')?.disabled"), true, 'Unsaved settings block applying a changed GPU selection');
  assert.deepEqual(chosenGpuIds.slice().sort(), ['amd:9700a', 'amd:9700b'], 'Editing GPU checkboxes does not start setup');
  await browser.click('input[name="runtime-gpu"][value="amd:9700a"]');
  assert.equal(await browser.evaluate("document.querySelectorAll('input[name=runtime-gpu]:checked').length"), 2, 'GPU selection is restored before returning to the draft');
  await browser.click('#settings-tab-connections');
  await clickScopedText('#settings-panel-connections', 'Add worker');
  await browser.until("document.querySelectorAll('#settings-panel-connections input[type=radio][name=worker-gpu]').length === 2", 'A manual worker retains one-GPU radio assignment');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-connections input[type=url]').readOnly"), false, 'Manual endpoints remain editable');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-connections input[type=url]').value"), '', 'A new manual worker starts without an assumed endpoint');
  await browser.fill('#settings-panel-connections input[type=url]', comfy.url);
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-connections input[type=url]').readOnly"), false, 'Typing a managed endpoint does not convert an unsaved manual worker into a managed connection');
  await browser.click('#settings-panel-connections button[aria-label="Remove selected worker"]');
  await browser.until("!document.querySelector('#settings-panel-connections input[name=worker-gpu]')", 'Removing the unsaved manual worker returns to the managed worker');
  await browser.fill(workerNameInput, 'Unsaved browser worker');
  await browser.click('#settings-tab-connections');
  await settingsKey('ArrowDown', 'models');
  await browser.fill('#settings-panel-models select', modelId);
  const modelWorkers = '#settings-panel-models input[type="checkbox"][name="model-worker"]';
  const selectedModelWorkers = `Array.from(document.querySelectorAll('${modelWorkers}:checked')).map(input => input.value)`;
  await browser.until(`document.querySelectorAll('${modelWorkers}').length === 2`, 'Model supports assignment to both workers');
  assert.equal(await browser.evaluate(`document.querySelector('${modelWorkers}').closest('fieldset').querySelector('legend').textContent.trim()`), 'Workers for this model');
  assert.deepEqual(await browser.evaluate(selectedModelWorkers), ['browser-comfy', 'browser-comfy-first'], 'An existing multi-worker assignment opens with both checkboxes checked');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-models input[name=model-auto-workers]').checked"), true, 'Imported models initially follow all Studio GPUs');
  await browser.click(`${modelWorkers}[value="browser-comfy-first"]`);
  assert.deepEqual(await browser.evaluate(selectedModelWorkers), ['browser-comfy'], 'Unchecking one worker preserves the other selection');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-models input[name=model-auto-workers]').checked"), false, 'An explicit worker choice switches the model to manual assignment');
  const checkpointInput = '#settings-panel-models input[list="artifacts-checkpoint"]';
  await browser.fill(checkpointInput, 'unsaved-browser-checkpoint.safetensors');
  await browser.click('#settings-tab-models');
  await settingsKey('ArrowUp', 'connections');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(workerNameInput)}).value`), 'Unsaved browser worker', 'Changing tabs preserves an unsaved connection name');
  await settingsKey('ArrowDown', 'models');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(checkpointInput)}).value`), 'unsaved-browser-checkpoint.safetensors', 'Changing tabs preserves an unsaved model filename');
  assert.deepEqual(await browser.evaluate(selectedModelWorkers), ['browser-comfy'], 'Changing tabs preserves the worker selection draft');
  await browser.click(`${modelWorkers}[value="browser-comfy-first"]`);
  assert.deepEqual(await browser.evaluate(selectedModelWorkers), ['browser-comfy', 'browser-comfy-first'], 'Both workers can be selected together');
  await browser.click('#settings-tab-generation');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation input[name=ramReserveGiB]').value"), '9', 'Changing tabs preserves the RAM reserve draft');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation input[name=vramReserveGiB]').value"), '1.5', 'Changing tabs preserves the VRAM reserve draft');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation input[name=maxConcurrentJobs]').value"), '1', 'Changing tabs preserves the concurrency draft');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation select[name=idleUnloadSeconds]').value"), '300', 'Changing tabs preserves the model retention draft');
  await settingsKey('Home', 'gpus');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation').hidden && document.querySelector('#settings-panel-connections').hidden && document.querySelector('#settings-panel-models').hidden"), true, 'Inactive sections remain mounted and hidden');
  await settingsKey('End', 'api');
  await browser.until("document.body.innerText.includes('API & MCP access')", 'API access settings');
  await browser.fill('input[placeholder="My MCP client"]', 'Browser test MCP');
  await browser.clickText('Create token');
  await browser.until("document.querySelector('input[aria-label=\"New access token\"]')?.value.startsWith('gs_')", 'Access token created');
  const token = await browser.evaluate<string>("document.querySelector('input[aria-label=\"New access token\"]').value");
  await browser.evaluate("void (window.__gravityTokenInput = document.querySelector('input[aria-label=\"New access token\"]'))");
  await browser.click('#settings-tab-gpus');
  await browser.until("document.querySelector('#settings-panel-api')?.hidden === true", 'API section hides when returning to GPUs');
  await browser.click('#settings-tab-api');
  await browser.until("document.querySelector('#settings-panel-api')?.hidden === false", 'API section reopens');
  assert.equal(await browser.evaluate("document.querySelector('input[aria-label=\"New access token\"]') === window.__gravityTokenInput"), true, 'Switching sections keeps the one-time token field mounted');
  assert.equal(await browser.evaluate("document.querySelector('input[aria-label=\"New access token\"]').value"), token, 'A newly created token remains available after changing sections');
  assert.equal(store.settings().workers[0].name, 'GPU 2', 'Tab navigation does not save the connection draft');
  assert.equal(store.settings().modelConfigurations.some(configuration => Object.values(configuration.artifacts).includes('unsaved-browser-checkpoint.safetensors')), false, 'Tab navigation does not save model file drafts');
  assert.deepEqual(store.settings().policy, savedPolicy, 'Tab navigation does not save generation policy drafts');
  assert.deepEqual(store.settings().modelConfigurations.find(configuration => configuration.modelId === modelId)?.workerIds, ['browser-comfy', 'browser-comfy-first'], 'Changing worker checkboxes does not save automatically');
  const apiResponse = await fetch(`${origin}/api/catalog`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(apiResponse.status, 200, 'The token authenticates API requests');
  const mcp = await fetch(`${origin}/api/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'browser-integration', version: '1.0.0' } } }) });
  assert.equal(mcp.status, 200, 'The frontend proxy forwards MCP transport headers');
  const mcpText = await mcp.text();
  const mcpResult = JSON.parse(mcp.headers.get('content-type')?.includes('text/event-stream') ? mcpText.split('\n').find(line => line.startsWith('data: '))!.slice(6) : mcpText) as { result: { serverInfo: { name: string } } };
  assert.equal(mcpResult.result.serverInfo.name, 'gravity-studio');
  await browser.clickText('I have saved it');
  await browser.until("!document.querySelector('input[aria-label=\"New access token\"]')", 'Token secret hidden');
  await browser.screenshot(join(output, 'api-mobile.png'));
  await browser.click('[aria-label="Revoke Browser test MCP"]');
  await browser.until("document.body.innerText.includes('No access tokens yet.')", 'Token revoked');
  assert.equal((await fetch(`${origin}/api/catalog`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  await browser.click('#settings-tab-connections');
  await browser.fill(workerNameInput, 'GPU 2');
  await browser.click('#settings-tab-models');
  await browser.fill(checkpointInput, filename);
  await browser.click('#settings-tab-generation');
  await clickScopedText('#settings-dialog', 'Save settings');
  await browser.until("document.querySelector('#settings-dialog')?.innerText.includes('Configuration saved.')", 'Generation settings save through the owner API');
  assert.deepEqual(store.settings().policy, { ...savedPolicy, ramReserveBytes: 9 * 1024 ** 3, vramReserveBytes: 1.5 * 1024 ** 3, maxConcurrentJobs: 1, idleUnloadSeconds: 300 });
  assert.deepEqual(store.settings().modelConfigurations.find(configuration => configuration.modelId === modelId)?.workerIds, ['browser-comfy', 'browser-comfy-first'], 'Saving settings retains both model workers');
  assert.equal(store.settings().modelConfigurations.find(configuration => configuration.modelId === modelId)?.workerSelection, 'manual', 'Saving preserves the explicit worker selection policy');
  assert.deepEqual(store.settings().workers.map(worker => ({ id: worker.id, baseUrl: worker.baseUrl, deviceId: worker.deviceIds[0] })), managedBindings, 'Saving the generation policy preserves managed GPU bindings');
  assert.equal('managedWorkers' in store.settings(), false, 'Managed runtime metadata stays outside persisted settings');
  await browser.click('button[aria-label="Close settings"]');
  await browser.until("!document.querySelector('#settings-dialog[open]')", 'Settings closes before account controls are used');
  await browser.click('[aria-label="Account"]');
  await browser.clickText('Sign out');
  await browser.until("document.body.innerText.includes('Welcome back.')", 'Signed out');
  await browser.fill('input[name="username"]', 'browser-owner');
  await browser.fill('input[name="password"]', 'test-password-strong-123');
  await browser.clickText('Sign in');
  await browser.until("!!document.querySelector('#image-prompt') && !document.querySelector('dialog[open]')", 'Owner signs back into the Image workspace');
  for (const label of ['Models', 'Settings']) {
    await browser.navigate(`${origin}/${label.toLowerCase()}`);
    await browser.until(`!!document.querySelector('#${label.toLowerCase()}-dialog[open]') && !!document.querySelector('#image-prompt')`, `${label} entry URL opens its dialog over Image`);
    await browser.click(`button[aria-label="Close ${label.toLowerCase()}"]`);
    await browser.until("!document.querySelector('dialog[open]') && !!document.querySelector('#image-prompt')", `${label} entry dialog closes to Image`);
  }

  // Read-only UI fixture: expose real catalog manifests as selectable without
  // installing their weights. No generation is submitted while readiness is overridden.
  const geometryModels = [
    { id: 'wai-illustrious-v17', name: 'WAI Illustrious v17', short: 'wai' },
    { id: 'flux-2-klein-4b', name: 'FLUX.2 Klein 4B', short: 'klein' },
    { id: 'krea-2-turbo', name: 'Krea 2 Turbo', short: 'krea' },
    { id: 'qwen-image-2.1', name: 'Qwen Image 2.1', short: 'qwen' },
    { id: 'sdxl-base', name: 'SDXL Base 1.0 with an unusually long checkpoint name that must remain readable in the model menu', short: 'long' },
  ];
  const draftKey = `gravity:image-draft:${store.owner()!.id}`;
  const savedDraft = await browser.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(draftKey)})`);
  const jobCount = store.jobs(store.owner()!.id).length;
  const submissionCount = comfy.state.submissions.length;
  const geometryPrompt = 'Keep this exact prompt while switching between image model families.';
  const dockSelectors = {
    dock: '[data-workspace-scroll="dock"]', prompt: '#image-prompt',
    model: 'button[aria-label^="Model:"]', aspect: 'button[aria-label^="Aspect ratio:"]',
    advanced: 'button[aria-label="Advanced settings"]', reset: 'button[aria-label="Reset settings to defaults"]',
    generate: 'button[title^="Submit to your generation queue"]',
    add: 'button[aria-label="Add reference image"]', browse: 'button[aria-label="Browse saved images"]',
  };
  type Geometry = Record<string, { x: number; y: number; width: number; height: number }>;
  async function geometry(selectors: Record<string, string>) {
    await browser.evaluate("Promise.all(document.querySelector('[data-workspace-scroll=\"dock\"]').getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)");
    await browser.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))');
    return browser.evaluate<Geometry>(`Object.fromEntries(Object.entries(${JSON.stringify(selectors)}).map(([name, selector]) => { const {x, y, width, height} = document.querySelector(selector).getBoundingClientRect(); return [name, {x, y, width, height}]; }))`);
  }
  function sameGeometry(actual: Geometry, expected: Geometry, label: string) {
    for (const name of Object.keys(expected)) for (const axis of ['x', 'y', 'width', 'height'] as const) {
      assert.ok(Math.abs(actual[name][axis] - expected[name][axis]) <= 1, `${label}: ${name}.${axis} changed from ${expected[name][axis]} to ${actual[name][axis]}`);
    }
  }
  async function selectGeometryModel(name: string) {
    await browser.click('button[aria-label^="Model:"]');
    const row = `Array.from(document.querySelectorAll('[popover]:popover-open [role=menuitem]')).find(row => row.textContent.includes(${JSON.stringify(name)}))`;
    await browser.until(`(() => { const row = (${row}); return row && !row.disabled && getComputedStyle(row).visibility === 'visible'; })()`, `${name} is selectable in the UI fixture`);
    await browser.evaluate(`(${row}).focus()`);
    await browser.key('Enter');
    await browser.until(`!!document.querySelector('button[aria-label=${JSON.stringify(`Model: ${name}`)}]') && !document.querySelector('[popover]:popover-open')`, `${name} selected`);
  }
  try {
    if (await browser.evaluate("!!document.querySelector('button[aria-label=\"Remove reference 1\"]')")) await browser.clickText('Remove all');
    await browser.fill('#image-prompt', geometryPrompt);
    await browser.evaluate(`(() => {
      const fixtures = new Map(${JSON.stringify(geometryModels.map(model => [model.id, model.name]))});
      window.__gravityOriginalFetch = window.fetch;
      window.__gravityUnavailableModel = 'wai-illustrious-v17';
      window.fetch = async (input, options) => {
        const response = await window.__gravityOriginalFetch.call(window, input, options);
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin !== location.origin || url.pathname !== '/api/catalog' || (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET' || !response.ok) return response;
        const catalog = await response.json();
        catalog.models = catalog.models.map(model => fixtures.has(model.id) ? { ...model, name: fixtures.get(model.id), installed: true, ready: model.id !== window.__gravityUnavailableModel, capabilities: { ...model.capabilities, ready: model.id !== window.__gravityUnavailableModel }, missingReasons: model.id === window.__gravityUnavailableModel ? ['Worker is offline'] : [], unavailableReason: model.id === window.__gravityUnavailableModel ? 'Worker is offline' : '' } : model);
        return new Response(JSON.stringify(catalog), { status: response.status, headers: { 'Content-Type': 'application/json' } });
      };
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await browser.click('button[aria-label^="Model:"]');
    await browser.until("Array.from(document.querySelectorAll('[popover]:popover-open [role=menuitem]')).find(row => row.textContent.includes('WAI Illustrious v17'))?.disabled === true", 'An installed model remains visible while its worker is offline');
    assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('[popover]:popover-open [role=menuitem]')).some(row => row.textContent.includes('FLUX.2 Klein 9B'))"), false, 'Uninstalled models remain absent alongside installed offline models');
    await browser.key('Escape');
    await browser.evaluate("delete window.__gravityUnavailableModel; document.dispatchEvent(new Event('visibilitychange'));");
    for (const viewport of [{ name: 'desktop', width: 1440, height: 960, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
      let dockBaseline: Geometry | undefined;
      let advancedBaseline: Geometry | undefined;
      const intrinsicWidths: Array<{ width: number; textWidth: number }> = [];
      await browser.evaluate("void (window.__gravityGeometryPrompt = document.querySelector('#image-prompt'))");
      for (const model of geometryModels) {
        await selectGeometryModel(model.name);
        const bounds = await geometry(dockSelectors);
        const stable = Object.fromEntries(Object.entries(bounds).filter(([name]) => !['model', 'aspect'].includes(name)));
        if (dockBaseline) sameGeometry(stable, dockBaseline, `${viewport.name} ${model.name}`);
        else dockBaseline = stable;
        const label = await browser.evaluate<{ name: string; title: string; clientWidth: number; scrollWidth: number; textWidth: number }>(`(() => {
          const button = document.querySelector('button[aria-label^="Model:"]'), label = button.querySelector(':scope > span:nth-of-type(2)'), range = document.createRange(); range.selectNodeContents(label);
          return { name: label.textContent, title: button.title, clientWidth: label.clientWidth, scrollWidth: label.scrollWidth, textWidth: range.getBoundingClientRect().width };
        })()`);
        assert.equal(label.name, model.name); assert.equal(label.title, model.name, 'The full model name remains available when the chip is truncated');
        if (model.short === 'long') {
          assert.ok(bounds.model.width <= 320.5 && bounds.model.width <= viewport.width, 'A long model name is capped at the available toolbar width');
          assert.ok(label.scrollWidth > label.clientWidth, 'A long name truncates inside its chip');
        } else {
          assert.ok(label.scrollWidth <= label.clientWidth + 1, 'Ordinary model names fit their natural chip width');
          intrinsicWidths.push({ width: bounds.model.width, textWidth: label.textWidth });
        }
        assert.ok(bounds.aspect.width > 44 && bounds.aspect.width < 80, 'The aspect chip fits its icon and label without a fixed width');
        assert.ok(Math.abs(bounds.model.height - 36) < .1); assert.ok(Math.abs(bounds.aspect.height - 36) < .1);
        for (const action of ['add', 'browse']) { assert.ok(Math.abs(bounds[action].width - 40) < .1); assert.ok(Math.abs(bounds[action].height - 40) < .1); }
        assert.equal(await browser.evaluate(`document.querySelector('#image-prompt') === window.__gravityGeometryPrompt && document.querySelector('#image-prompt').value === ${JSON.stringify(geometryPrompt)}`), true, 'Model changes preserve the same prompt element and text');
        const noReferences = model.short === 'krea';
        for (const selector of [dockSelectors.add, dockSelectors.browse, 'input[aria-label="Upload reference images"]']) {
          assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`), noReferences, `${model.name} advertises its reference capability`);
        }
        if (model.short === 'qwen') {
          assert.equal(await browser.evaluate("document.querySelector('input[aria-label=\"Upload reference images\"]').multiple"), true, 'Qwen supports selecting multiple references');
          assert.equal(await browser.evaluate("fetch('/api/catalog').then(response => response.json()).then(catalog => catalog.models.find(model => model.id === 'qwen-image-2.1').capabilities.maxImages)"), 10, 'Qwen advertises ten reference images to the composer');
        }
        if (noReferences) assert.match(await browser.evaluate<string>(`document.querySelector(${JSON.stringify(dockSelectors.add)}).title`), /not supported/i);
        assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true, 'Switching models does not overflow the page');
        await browser.screenshot(join(output, `toolbar-${model.short}-${viewport.name}.png`));
        await openAdvanced();
        await browser.evaluate("document.querySelectorAll('[popover]:popover-open *').forEach(element => { if (getComputedStyle(element).overflowY === 'auto') element.scrollTop = 0; })");
        await browser.evaluate("Promise.all(document.querySelector('[popover]:popover-open').getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)");
        const advanced = await geometry({ panel: '[aria-label="Advanced settings"]:popover-open', seed: '[popover]:popover-open input[aria-label="Seed"]', width: '[popover]:popover-open input[aria-label="Width value"]', guidance: '[popover]:popover-open input[aria-label="Guidance value"]' });
        if (advancedBaseline) sameGeometry(advanced, advancedBaseline, `${viewport.name} ${model.name} Advanced`);
        else advancedBaseline = advanced;
        assert.equal(await browser.evaluate("!!document.querySelector('[popover]:popover-open textarea[aria-label=\"Negative prompt\"]')"), ['wai', 'qwen', 'long'].includes(model.short), 'Only models advertising negative prompts expose the field');
        await screenshotPopover(`advanced-${model.short}-${viewport.name}.png`);
        await browser.key('Escape');
      }
      assert.ok(Math.max(...intrinsicWidths.map(item => item.width)) - Math.min(...intrinsicWidths.map(item => item.width)) > 8, 'Shorter and longer model names have different chip widths');
      const chromeWidth = intrinsicWidths[0].width - intrinsicWidths[0].textWidth;
      for (const measured of intrinsicWidths) assert.ok(Math.abs(measured.width - measured.textWidth - chromeWidth) <= 2, 'Chip width follows its model label while retaining consistent icon spacing');
    }
    await selectGeometryModel('FLUX.2 Klein 4B');
    await uploadReference();
    await browser.click('button[aria-label="Browse saved images"]');
    await browser.until("document.querySelectorAll('#reference-picker-dialog article[data-asset-id]').length >= 4", 'Multi-reference picker loads more assets than its remaining capacity');
    const choices = await browser.evaluate<string[]>("Array.from(document.querySelectorAll('#reference-picker-dialog article[data-asset-id]')).slice(0, 4).map(article => article.dataset.assetId)");
    const choice = (id: string) => `#reference-picker-dialog article[data-asset-id="${id}"] button[aria-pressed]`;
    for (const id of choices.slice(0, 3)) await browser.click(choice(id));
    assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]').length"), 3, 'Klein allows three more selections beside its existing reference');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(choice(choices[3]))}).disabled`), true, 'The remaining asset is blocked when the model capacity is full');
    await browser.click(choice(choices[0]));
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(choice(choices[3]))}).disabled`), false, 'Deselecting frees one slot');
    await browser.click(choice(choices[0]));
    await browser.evaluate(`(() => {
      window.__gravityPickerFetch = window.fetch;
      let uploads = 0;
      window.fetch = (input, options = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (url.origin === location.origin && url.pathname === '/api/inputs' && method === 'POST' && ++uploads === 2) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Reference upload interrupted.' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
        return window.__gravityPickerFetch.call(window, input, options);
      };
    })()`);
    try {
      await clickScopedText('#reference-picker-dialog', 'Use selected');
      await browser.until("document.querySelector('#reference-picker-dialog[open] [role=alert]')?.textContent.includes('Reference upload interrupted.')", 'A failed batch keeps the picker open with its upload error');
      assert.equal(await browser.evaluate("document.querySelectorAll('button[aria-label^=\"Remove reference \"]').length"), 1, 'A failed second upload does not partially update the composer');
      assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]').length"), 3, 'A failed upload keeps all selected assets for retry');
      await browser.screenshot(join(output, 'assets-picker-error-mobile.png'));
    } finally { await browser.evaluate('window.fetch = window.__gravityPickerFetch; delete window.__gravityPickerFetch'); }
    await clickScopedText('#reference-picker-dialog', 'Use selected');
    await browser.until("!document.querySelector('#reference-picker-dialog[open]') && document.querySelectorAll('button[aria-label^=\"Remove reference \"]').length === 4", 'Retry adds the entire selected batch and closes the picker');
    assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Browse saved images\"]').disabled"), true, 'A full model cannot open another reference selection');
    assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), geometryPrompt, 'Adding several references preserves the prompt');
    await browser.clickText('Remove all');
    assert.equal(store.jobs(store.owner()!.id).length, jobCount, 'The geometry fixture creates no generation jobs');
    assert.equal(comfy.state.submissions.length, submissionCount, 'The geometry fixture submits no ComfyUI prompts');
  } finally {
    await browser.evaluate(`(() => { if (window.__gravityOriginalFetch) { window.fetch = window.__gravityOriginalFetch; delete window.__gravityOriginalFetch; } delete window.__gravityGeometryPrompt; delete window.__gravityUnavailableModel; ${savedDraft === null ? `localStorage.removeItem(${JSON.stringify(draftKey)});` : `localStorage.setItem(${JSON.stringify(draftKey)}, ${JSON.stringify(savedDraft)});`} })()`);
    await browser.send('Page.reload');
    await browser.until("!!document.querySelector('button[aria-label=\"Model: Browser checkpoint\"]')", 'Real catalog and saved draft restored after the geometry fixture');
  }
  assert.equal(await browser.evaluate(`fetch('/api/catalog').then(response => response.json()).then(catalog => catalog.models.filter(model => ${JSON.stringify(geometryModels.map(model => model.id))}.includes(model.id)).every(model => !model.ready))`), true, 'Real readiness is restored after the UI-only fixture');
  await browser.click('[aria-label="Open Browser checkpoint output"]');
  await browser.until("!!document.querySelector('#output-viewer[open]')", 'Reopen an output to reuse its settings');
  await clickScopedText('#output-viewer', 'Use these settings');
  await browser.until("!document.querySelector('#output-viewer[open]') && document.activeElement === document.querySelector('#image-prompt')", 'Reusing settings closes the viewer and focuses the composer');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), store.jobs(store.owner()!.id).find(job => job.outputs.length)!.prompt, 'Reuse restores the selected output prompt');
  assert.deepEqual(browser.errors, []);
  t.diagnostic(`Screenshots: ${output}`);
});
