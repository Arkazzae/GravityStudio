import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { LOCAL_TEXT_MODEL } from '../../apps/server/text-models.ts';
import type { LocalTextRuntime } from '../../apps/server/local-text.ts';
import type { LocalTextStatus } from '../../packages/contracts/text.ts';
import { ApiError } from '../../packages/contracts/index.ts';
import type { RuntimeSetupStatus } from '../../apps/server/runtime.ts';
import { createStudioServer } from '../../apps/server/http.ts';
import { createSession } from '../../apps/server/auth.ts';
import { dualR9700 } from '../hardware/fixtures.ts';
import { completed, fakeComfy } from '../inference/fake-comfy.ts';
import { engineFixture } from '../server/helpers/engine-fixture.ts';
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
  inventory.gpus = inventory.gpus.map((gpu, index) => ({ ...gpu, name: 'AMD Radeon AI PRO R9700', pciAddress: index ? '0000:07:00.0' : '0000:03:00.0', memory: { ...gpu.memory, usedBytes: (index ? 8 : 4) * 1024 ** 3 } }));
  inventory.host.memory.availableBytes = 72 * 1024 ** 3;
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
  // Container execution, managed text lifecycle and upstream responses are fixtures.
  // Owner APIs, image downloads, settings, generation and prompt refinement use their real code.
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
  const models = new ModelLibrary(store, engine, { fetch: async (input, init) => {
    assert.equal(String(input), source);
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': String(fixtureCheckpoint.length) } });
    await checkpointResponseReady;
    return new Response(fixtureCheckpoint, { headers: { 'Content-Length': String(fixtureCheckpoint.length) } });
  } });
  let integrationResponseStatus = 200;
  const integrationRequests: Array<{ url: string; authorization: string | null }> = [];
  let assistantPrompt = 'A ceramic teapot on an oak table, lit by warm evening light.';
  let holdTextResponse = false;
  let textRequests = 0;
  let textAborts = 0;
  let finishTextResponse: (() => void) | undefined;
  const localModel = { id: LOCAL_TEXT_MODEL.id, name: LOCAL_TEXT_MODEL.name, inputTokenLimit: 5888, outputTokenLimit: 2048 };
  const localState: LocalTextStatus = {
    revision: 0, model: { ...LOCAL_TEXT_MODEL }, phase: 'idle', ready: false, installed: false, busy: false, message: '', error: null, download: null, gpuId: null, gpuIds: [],
    gpus: inventory.gpus.map(gpu => ({ id: gpu.id, name: gpu.name, memoryBytes: gpu.memory.totalBytes, supported: true, ...(gpu.pciAddress ? { pciAddress: gpu.pciAddress } : {}) })),
  };
  let localPreparations = 0;
  let localRuns = 0;
  let localReleases = 0;
  let localStatusReads = 0;
  let localUnloadFails = false;
  const localText: NonNullable<Parameters<typeof createStudioServer>[0]['localText']> = {
    initialize: async () => {},
    status: async () => { localStatusReads++; return structuredClone(localState); },
    prepare: async body => {
      assert.deepEqual(body, { modelId: LOCAL_TEXT_MODEL.id });
      localPreparations++;
      Object.assign(localState, { phase: 'downloading', busy: true, message: 'Downloading and verifying MiMo Q8_0', download: { receivedBytes: 0, totalBytes: LOCAL_TEXT_MODEL.sizeBytes } });
      return structuredClone(localState);
    },
    configure: async body => {
      const input = body as { revision: number; gpuIds: string[] };
      assert.equal(input.revision, localState.revision);
      assert.ok(input.gpuIds.every(id => inventory.gpus.some(gpu => gpu.id === id)));
      localState.revision++; localState.gpuIds = [...input.gpuIds];
      return structuredClone(localState);
    },
    models: async () => ({ provider: 'local', models: localState.ready ? [localModel] : [] }),
    run: async (modelId, signal, work) => {
      assert.equal(modelId, LOCAL_TEXT_MODEL.id); assert.equal(localState.ready, true);
      signal.throwIfAborted(); localRuns++;
      Object.assign(localState, { phase: 'running', busy: true, gpuId: localState.gpuIds[0] || inventory.gpus[0].id });
      try { return await work({ provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', apiKey: 'browser-local-runtime-secret' }, localModel); }
      finally { Object.assign(localState, { phase: signal.aborted ? 'ready' : 'loaded', busy: false, ...(signal.aborted ? { gpuId: null } : {}) }); }
    },
    release: async () => {
      localReleases++;
      if (localUnloadFails) {
        localUnloadFails = false; localState.phase = 'failed'; localState.error = 'Could not confirm the local model stopped. Retry unloading it.';
        throw new ApiError(503, 'LOCAL_TEXT_STOP_FAILED', localState.error);
      }
      Object.assign(localState, { phase: 'ready', gpuId: null, error: null, message: 'GPU memory released' });
      return structuredClone(localState);
    },
    evictIdle: async () => { if (localState.phase !== 'loaded') return false; Object.assign(localState, { phase: 'ready', gpuId: null }); return true; },
    close: async () => {},
  } satisfies Pick<LocalTextRuntime, 'initialize' | 'status' | 'prepare' | 'configure' | 'release' | 'models' | 'run' | 'evictIdle' | 'close'>;
  const server = await createStudioServer({ store, engine, runtime, models, localText, integrationFetch: async (input, init) => {
    integrationRequests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
    return Response.json({ data: [] }, { status: integrationResponseStatus });
  }, textFetch: async (input, init) => {
    const url = String(input);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-text' }] });
    assert.ok(['http://127.0.0.1:18081/v1/chat/completions', 'http://localhost:8080/v1/chat/completions'].includes(url));
    assert.equal(new Headers(init?.headers).get('authorization'), url.startsWith('http://localhost:8080/') ? 'Bearer browser-local-runtime-secret' : 'Bearer browser-text-key-ef56');
    textRequests++;
    if (holdTextResponse) await new Promise<void>((resolve, reject) => {
      const aborted = () => { textAborts++; reject(new DOMException('Aborted', 'AbortError')); };
      finishTextResponse = () => { init?.signal?.removeEventListener('abort', aborted); resolve(); };
      if (init?.signal?.aborted) aborted(); else init?.signal?.addEventListener('abort', aborted, { once: true });
    });
    return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ prompt: assistantPrompt }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 16 } });
  }, allowedOrigins: [origin], setupSecret: 'browser-integration-setup-key' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await engine.start();
  let logs = '';
  function startFrontend() {
    const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-8000); }); child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-8000); });
    return child;
  }
  let child = startFrontend();
  t.after(async () => { clearInterval(completion); child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL'); await server.closeOperations(); await engine.stop(); await close(server); await Promise.all([comfy.close(), otherComfy.close()]); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ } if (child.exitCode !== null) throw new Error(`Next could not start: ${logs}`); if (attempt === 99) throw new Error(`Next startup timed out: ${logs}`); await delay(100); }
  for (const path of ['/manifest.webmanifest', '/sw.js', '/offline.html', '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/icon-maskable-512.png', '/pwa/apple-touch-icon.png']) {
    assert.equal((await fetch(origin + path, { redirect: 'manual' })).status, 200, `${path} is available before signing in`);
  }
  const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json() as { name: string; display: string; start_url: string; scope: string; icons: Array<{ src: string; purpose: string; sizes: string }> };
  assert.equal(manifest.name, 'Gravity Studio');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/image');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable' && icon.sizes === '512x512'), 'Installed applications have a maskable icon');
  const workerScript = await fetch(`${origin}/sw.js`);
  assert.match(workerScript.headers.get('cache-control') || '', /no-store/, 'A service-worker update is not hidden by the HTTP cache');
  assert.ok((await workerScript.text()).includes((await readFile(join(studio, '.next/BUILD_ID'), 'utf8')).trim()), 'The worker revision changes with the production build');
  const browser = await openBrowser(t);
  async function clickScopedText(scope: string, label: string) {
    const element = `Array.from(document.querySelectorAll('${scope} button, ${scope} a')).find(element => element.textContent.trim() === ${JSON.stringify(label)})`;
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    await browser.until(`(() => { const element = (${element}); return element && !element.matches(':disabled') && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible'; })()`, `${label} in ${scope}`);
    const point = await browser.evaluate<{ x: number; y: number }>(`(() => { const element = (${element}); element.scrollIntoView({block: 'nearest'}); const rect = element.getBoundingClientRect(); return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}; })()`);
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  async function dismissBackdrop(id: string) {
    await browser.evaluate(`Promise.all(document.querySelector('#${id}').getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)`);
    const point = await browser.evaluate<{ x: number; y: number } | null>(`(() => { const rect = document.querySelector('#${id}').getBoundingClientRect(); return [{x: 2, y: 2}, {x: innerWidth - 2, y: 2}, {x: 2, y: innerHeight - 2}, {x: innerWidth - 2, y: innerHeight - 2}].find(point => point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom) || null; })()`);
    assert.ok(point, 'The modal leaves a clickable backdrop');
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await browser.until(`!document.querySelector('#${id}[open]')`, `${id} closes from its backdrop`);
  }
  async function openAdvanced() {
    await browser.click('button[aria-label="Advanced settings"]');
    await browser.until("(() => { const panel = document.querySelector('[aria-label=\"Advanced settings\"]:popover-open'); return panel && getComputedStyle(panel).visibility === 'visible'; })()", 'Advanced settings opens');
  }
  async function openQuality() {
    await browser.click('button[aria-label^="Quality:"]');
    await browser.until("(() => { const trigger = document.querySelector('button[aria-label^=\"Quality:\"]'), menu = document.getElementById(trigger.getAttribute('aria-controls')); return trigger.getAttribute('aria-expanded') === 'true' && menu?.matches(':popover-open') && getComputedStyle(menu).visibility === 'visible' && document.activeElement?.getAttribute('role') === 'menuitem' && menu.contains(document.activeElement); })()", 'Quality is visible and receives menu focus');
  }
  async function screenshotPopover(name: string) {
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('[popover]:popover-open').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)");
    await browser.screenshot(join(output, name));
  }
  const activityScope = '[role="dialog"][aria-label="Server activity"]:popover-open';
  async function openActivity() {
    await browser.click('[data-server-activity]');
    await browser.until(`!!document.querySelector(${JSON.stringify(activityScope)})`, 'Server activity opens');
  }
  async function activityFrame(name: 'idle' | 'active' | 'offline') {
    for (const mobile of [false, true]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 960, deviceScaleFactor: 1, mobile });
      await browser.evaluate(`Promise.all([document.fonts.ready, ...document.querySelector(${JSON.stringify(activityScope)}).getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`);
      assert.equal(await browser.evaluate(`(() => { const panel = document.querySelector(${JSON.stringify(activityScope)}), rect = panel.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1 && panel.scrollWidth <= panel.clientWidth + 1; })()`), true, `The ${name} server panel fits the ${mobile ? 'mobile' : 'desktop'} viewport`);
      await browser.screenshot(join(output, `activity-${name}-${mobile ? 'mobile' : 'desktop'}.png`));
    }
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
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
  async function assetCategory(label: string, id = 'reference-picker-dialog') {
    const button = `Array.from(document.querySelectorAll('#${id} nav[aria-label="Asset categories"] button')).find(button => button.textContent.trim().startsWith(${JSON.stringify(label)}))`;
    await browser.until(`!!(${button})`, `Asset category ${label}`);
    await browser.evaluate(`(${button}).focus()`);
    await browser.key('Enter');
    await browser.until(`(${button})?.getAttribute('aria-current') === 'page'`, `${label} asset category selected`);
  }
  async function galleryFilter(label: 'All images' | 'Favorites') {
    await clickScopedText('[aria-label="Image filter"]', label);
    await browser.until(`Array.from(document.querySelectorAll('[aria-label="Image filter"] button')).find(button => button.textContent.trim() === ${JSON.stringify(label)})?.getAttribute('aria-pressed') === 'true'`, `${label} gallery filter selected`);
  }
  async function assetPickerFrame(mobile: boolean) {
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('#reference-picker-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)");
    assert.equal(await browser.evaluate(`(() => {
      const dialog = document.querySelector('#reference-picker-dialog'), rect = dialog.getBoundingClientRect();
      return dialog.matches(':modal') && Math.abs(rect.width - ${mobile ? 374 : 1040}) <= 1 && Math.abs(rect.height - 820) <= 1 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && dialog.scrollWidth <= dialog.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
    })()`), true, 'The asset picker fits its shared modal frame without horizontal overflow');
  }
  async function uploadAsset() {
    const file = join(directory, 'asset-management-upload.png');
    await writeFile(file, comfy.state.outputBytes);
    await browser.send('Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      await browser.click('#assets-browser-dialog button[aria-label="Upload images"]');
      const document = await browser.send('DOM.getDocument') as unknown as { root: { nodeId: number } };
      const input = await browser.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#assets-browser-dialog input[aria-label="Upload images"]' }) as unknown as { nodeId: number };
      assert.ok(input.nodeId, 'The asset library uploads through its own native file input');
      await browser.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
      await browser.until("!!document.querySelector('#assets-browser-dialog article[data-source=import] button[aria-label=\"Open asset-management-upload.png\"]')", 'The uploaded image appears in the asset library');
    } finally { await browser.send('Page.setInterceptFileChooserDialog', { enabled: false }); }
  }
  async function assetPreviewFrame(id: 'assets-output-viewer' | 'assets-input-viewer') {
    for (const mobile of [false, true]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 960, deviceScaleFactor: 1, mobile });
      await browser.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))');
      assert.equal(await browser.evaluate(`(() => { const dialog = document.querySelector('#${id}'), rect = dialog.getBoundingClientRect(); return dialog.matches(':modal') && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth; })()`), true, 'Asset previews fit desktop and mobile viewports');
      await browser.screenshot(join(output, `${id}-${mobile ? 'mobile' : 'desktop'}.png`));
    }
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
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
  const modelSections = ['library', 'installed', 'tools', 'huggingface', 'downloads', 'language'];
  assert.equal(await browser.evaluate("document.querySelector('[role=tablist][aria-label=\"Model sections\"]').getAttribute('aria-orientation')"), 'vertical');
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('[role=tablist][aria-label=\"Model sections\"] [role=tab]')).map(tab => tab.textContent.trim())"), ['Library', 'Installed', 'Tools', 'Hugging Face', 'Downloads', 'Language']);
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
  await modelSectionKey('ArrowDown', 'tools');
  await modelFrame(false);
  await modelSectionKey('ArrowDown', 'huggingface');
  await browser.fill('input[name="checkpoint-url"]', checkpointUrl);
  await browser.fill('input[name="checkpoint-name"]', 'Browser checkpoint');
  await modelFrame(false);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
  await browser.until("(() => { const content = document.querySelector('#models-panel-huggingface').parentElement; return content.scrollHeight > content.clientHeight; })()", 'The Hugging Face form has real overflow in a short mobile viewport');
  const modelsScroll = await browser.evaluate<number>("(() => { const content = document.querySelector('#models-panel-huggingface').parentElement; content.scrollTop = Math.min(80, content.scrollHeight - content.clientHeight); return content.scrollTop; })()");
  assert.ok(modelsScroll > 0, 'Models scroll preservation uses a nonzero position');
  await dismissBackdrop('models-dialog');
  await browser.click('header button[aria-label="Models"]');
  await browser.until("document.querySelector('#models-dialog[open]') && document.querySelector('#models-tab-huggingface')?.getAttribute('aria-selected') === 'true'", 'Models returns to the dismissed Hugging Face tab');
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  assert.equal(await browser.evaluate("document.querySelector('input[name=checkpoint-url]').value"), checkpointUrl, 'Backdrop dismissal keeps the unfinished Hugging Face URL');
  assert.equal(await browser.evaluate("document.querySelector('input[name=checkpoint-name]').value"), 'Browser checkpoint', 'Backdrop dismissal keeps the unfinished checkpoint name');
  assert.equal(await browser.evaluate("document.querySelector('#models-panel-huggingface').parentElement.scrollTop"), modelsScroll, 'Reopening Models restores its content scroll');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await browser.click('#models-tab-huggingface');
  await modelSectionKey('ArrowDown', 'downloads');
  await modelFrame(false);
  await modelSectionKey('Home', 'library');
  await modelSectionKey('End', 'language');
  await modelSectionKey('ArrowUp', 'downloads');
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
  await browser.until("document.querySelector('#models-dialog[open]') && document.querySelector('#models-tab-downloads')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#models-panel-downloads progress')", 'Reopening Models retains Downloads and its ongoing progress');
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
  await openActivity();
  for (const [number, pci, used] of [[1, '0000:03:00.0', 4], [2, '0000:07:00.0', 8]] as const) {
    const gpuLabel = `GPU ${number} · AMD Radeon AI PRO R9700`;
    await browser.until(`document.querySelector(${JSON.stringify(`${activityScope} [aria-label="${gpuLabel}"]`)})?.textContent.includes(${JSON.stringify(pci)})`, 'Identical GPU cards retain their numbered hardware identity');
    const meter = await browser.evaluate<{ now: number; max: number; text: string }>(`(() => { const meter = document.querySelector(${JSON.stringify(`${activityScope} [role="meter"][aria-label="${gpuLabel} memory"]`)}); return {now:Number(meter.getAttribute('aria-valuenow')), max:Number(meter.getAttribute('aria-valuemax')), text:meter.getAttribute('aria-valuetext') || meter.parentElement.textContent}; })()`);
    assert.equal(meter.now / meter.max, used / 32, 'GPU usage uses observed used memory rather than total VRAM');
    assert.match(meter.text, new RegExp(`\\b${used}(?:\\.0)?\\b.*\\b32(?:\\.0)?\\b`), 'The GPU meter exposes used and total memory');
  }
  const ramMeter = await browser.evaluate<{ now: number; max: number }>(`(() => { const meter = document.querySelector(${JSON.stringify(`${activityScope} [role="meter"][aria-label="System RAM used"]`)}); return {now:Number(meter.getAttribute('aria-valuenow')),max:Number(meter.getAttribute('aria-valuemax'))}; })()`);
  assert.equal(ramMeter.now / ramMeter.max, 24 / 96, 'RAM reports used memory as total minus available');
  await activityFrame('idle');
  await browser.evaluate("window.__gravityActivityFetch = window.fetch; window.__gravityOfflineReads = {}; window.fetch = async function(input, init) { const url = typeof input === 'string' ? input : input.url; if (['/api/state', '/api/catalog', '/api/favorites'].includes(url)) { window.__gravityOfflineReads[url] = (window.__gravityOfflineReads[url] || 0) + 1; throw new TypeError('Studio connection interrupted'); } return window.__gravityActivityFetch.call(this, input, init); }");
  try {
    await browser.click(`${activityScope} button[aria-label="Refresh activity"]`);
    await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'offline'", 'Refresh reports a disconnected Studio');
    await browser.until("['/api/state', '/api/catalog', '/api/favorites'].every(path => window.__gravityOfflineReads[path] > 0)", 'All passive data requests observe the outage');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(activityScope)}).querySelectorAll('[role="meter"]').length`), 0, 'A disconnected panel does not present stale GPU or RAM readings');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(activityScope)}).textContent.includes('Studio connection interrupted')`), true, 'Connection details appear in the activity panel');
    assert.equal(await browser.evaluate("!!document.querySelector('header + [role=alert], main [role=alert]') || document.querySelector('main').textContent.includes('Waiting for the studio server')"), false, 'Passive connection failures add no banners to the workspace or composer');
    await activityFrame('offline');
  } finally {
    await browser.evaluate('window.fetch = window.__gravityActivityFetch; delete window.__gravityActivityFetch');
  }
  await browser.click(`${activityScope} button[aria-label="Refresh activity"]`);
  await browser.until(`document.querySelector('[data-server-activity]')?.dataset.state === 'idle' && document.querySelector(${JSON.stringify(activityScope)}).querySelectorAll('[role="meter"]').length === 3`, 'Refresh restores live hardware readings');
  await browser.evaluate("window.__gravityActivityFetch = window.fetch; window.fetch = async function(input, init) { const url = typeof input === 'string' ? input : input.url; if (url === '/api/catalog') return new Response(JSON.stringify({error:{message:'Studio server unavailable'}}), {status:503, headers:{'Content-Type':'application/json'}}); return window.__gravityActivityFetch.call(this, input, init); }");
  try {
    await browser.click(`${activityScope} button[aria-label="Refresh activity"]`);
    await browser.until(`document.querySelector(${JSON.stringify(activityScope)}).textContent.includes('Studio server unavailable')`, 'An unavailable catalog is reported by the activity panel');
    assert.equal(await browser.evaluate("document.querySelector('[data-server-activity]').dataset.state"), 'attention', 'A partial outage is distinct from a disconnected server');
    assert.equal(await browser.evaluate("!!document.querySelector('header + [role=alert], main [role=alert]')"), false, 'A catalog outage does not create a duplicate banner');
  } finally {
    await browser.evaluate('window.fetch = window.__gravityActivityFetch; delete window.__gravityActivityFetch');
  }
  await browser.click(`${activityScope} button[aria-label="Refresh activity"]`);
  await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'idle'", 'Retry clears the partial outage');
  await browser.click('button[aria-label="Close activity"]');
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
  assert.equal(await browser.evaluate("!!document.querySelector('button[aria-label=\"Quality: Custom\"]')"), true, 'Manual dimensions mark the resolution quality as Custom');
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
  await openQuality();
  await browser.until("!!document.querySelector('[popover]:popover-open [aria-label=\"Quality Custom\"][aria-current=true]:disabled')", 'Custom dimensions remain visible as the current quality');
  await screenshotPopover('quality-custom-desktop.png');
  await browser.key('Escape');
  assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'), 'Quality: Custom', 'Escape returns focus to Quality');
  completeAutomatically = false;
  await browser.clickText('Generate');
  await browser.until("['queued', 'running'].includes(document.querySelector('[data-server-activity]')?.dataset.state)", 'Server activity reflects the pending generation');
  await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'running'", 'The first image starts on its assigned worker');
  const queuedActivityJob = await browser.evaluate<{ id: string }>(`fetch('/api/jobs', {method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':'browser-activity-queued'}, body:JSON.stringify({modelId:${JSON.stringify(modelId)},prompt:'Queued activity panel cancellation'})}).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body.job; })`);
  await openActivity();
  await browser.until(`document.querySelector(${JSON.stringify(activityScope)})?.textContent.includes('Browser checkpoint') && !!document.querySelector(${JSON.stringify(`${activityScope} button[aria-label="Cancel queued job: Queued activity panel cancellation"]`)})`, 'The activity panel identifies the active model and queued generation');
  const activeImage = store.jobs(store.owner()!.id).find(job => job.prompt === prompt && job.status === 'running')!;
  await browser.until(`document.querySelector(${JSON.stringify(activityScope)})?.textContent.includes(${JSON.stringify(activeImage.stage)})`, 'The model row reports the real generation stage');
  assert.equal(await browser.evaluate(`!!document.querySelector(${JSON.stringify(`${activityScope} button[aria-label="Release cache for GPU 2"]:not(:disabled)`)})`), false, 'Image memory cannot be released while its worker is generating');
  const freesWhileActive = comfy.state.frees;
  await activityFrame('active');
  await browser.click(`${activityScope} button[aria-label="Cancel queued job: Queued activity panel cancellation"]`);
  await browser.until(`!document.querySelector(${JSON.stringify(`${activityScope} button[aria-label="Cancel queued job: Queued activity panel cancellation"]`)})`, 'Cancel removes the queued job from activity');
  assert.equal(store.job(queuedActivityJob.id).status, 'cancelled', 'The queued cancellation is saved through the real owner API');
  assert.equal(comfy.state.frees, freesWhileActive, 'Inspecting active work never releases its model cache');
  await browser.click('button[aria-label="Close activity"]');
  completeAutomatically = true;
  await browser.until("!!document.querySelector('button[aria-label=\"Open Browser checkpoint output\"]')", 'Generated output in gallery');
  await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'idle'", 'Server activity returns to idle after generation');
  const first = store.jobs(store.owner()!.id).find(job => job.prompt === prompt && job.status === 'succeeded')!;
  assert.equal(first.status, 'succeeded'); assert.equal(first.parameters.seed, 1234); assert.equal(comfy.state.submissions.length, 1);
  assert.deepEqual({ width: first.parameters.width, height: first.parameters.height, steps: first.parameters.steps, cfg: first.parameters.cfg, negativePrompt: first.parameters.negativePrompt }, { width: generationWidth, height: 768, steps: 24, cfg: 6.5, negativePrompt: 'text, watermark' }, 'Generation uses the edited toolbar parameters');
  await openActivity();
  await browser.until(`document.querySelector(${JSON.stringify(`${activityScope} button[aria-label="Release cache for GPU 2"]`)})?.disabled === false`, 'An idle image worker offers cache release');
  const releasesBefore = comfy.state.frees;
  await browser.click(`${activityScope} button[aria-label="Release cache for GPU 2"]`);
  await browser.until(`document.querySelector(${JSON.stringify(activityScope)})?.textContent.includes('Release requested')`, 'The cache action acknowledges the request without claiming measured VRAM was already released');
  assert.equal(comfy.state.frees, releasesBefore + 1, 'Releasing image cache uses ComfyUI free after its queue is confirmed idle');
  assert.equal(store.job(first.id).outputs.length, 1, 'Releasing model cache preserves saved images');
  await browser.click('button[aria-label="Close activity"]');
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
  assert.equal(await browser.evaluate("!!document.querySelector('button[aria-label=\"Quality: High\"]')"), true, 'Reset restores the SDXL model default quality');
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
  const assetBrowserDraft = await browser.evaluate<string>("document.querySelector('#image-prompt').value");
  const inputsBeforeBrowserUpload = store.inputs(store.owner()!.id).length;
  await browser.click('header button[aria-label="Assets"]');
  await browser.until("document.querySelector('#assets-browser-dialog[open]')?.matches(':modal') && document.querySelectorAll('#assets-browser-dialog article[data-asset-id]').length === 2", 'The topbar opens a browser for generated and imported images');
  assert.match(await browser.evaluate<string>("document.querySelector('#assets-browser-dialog nav button[aria-current=page]').textContent"), /^All Assets/, 'The asset browser starts with all image sources');
  assert.equal(await browser.evaluate("document.querySelectorAll('#assets-browser-dialog button[aria-pressed]:not([data-favorite-action]), #assets-browser-dialog input[type=checkbox]').length"), 0, 'Asset thumbnails have no reference-selection state');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#assets-browser-dialog button')).some(button => ['Use selected', 'Clear selection'].includes(button.textContent.trim()))"), false, 'Browsing Assets has no reference-confirmation footer');
  const browserGenerated = `#assets-browser-dialog article[data-asset-id="${first.outputs[0].id}"]`;
  await browser.click(`${browserGenerated} button[aria-label="Add to favorites"]`);
  await browser.until(`document.querySelector(${JSON.stringify(`${browserGenerated} button[aria-label="Remove from favorites"]`)})?.getAttribute('aria-pressed') === 'true'`, 'A generated image can be favorited directly in Assets');
  assert.equal(await browser.evaluate("!!document.querySelector('#assets-output-viewer[open]')"), false, 'Favoriting an asset does not open its preview');
  await assetCategory('Favorites', 'assets-browser-dialog');
  await browser.until(`document.querySelectorAll('#assets-browser-dialog article[data-asset-id]').length === 1 && !!document.querySelector(${JSON.stringify(browserGenerated)})`, 'Assets Favorites contains the newly saved image');
  await browser.click(`${browserGenerated} button[aria-label=${JSON.stringify(`Open ${prompt}`)}]`);
  await browser.until("document.querySelector('#assets-output-viewer[open] button[aria-label=\"Remove from favorites\"]')?.getAttribute('aria-pressed') === 'true'", 'The sole browser favorite opens in its preview');
  await browser.click('#assets-output-viewer button[aria-label="Remove from favorites"]');
  await browser.until("!document.querySelector('#assets-output-viewer[open]') && !!document.querySelector('#assets-browser-dialog[open]') && !document.querySelector('#assets-browser-dialog article[data-asset-id]')", 'Removing the sole favorite closes its preview and leaves the empty asset browser open');
  assert.equal(await browser.evaluate("(() => { const browser = document.querySelector('#assets-browser-dialog'), focused = document.activeElement; return browser.contains(focused) && focused instanceof HTMLElement && focused.getClientRects().length > 0 && !focused.closest('dialog:not([open])'); })()"), true, 'When its image disappears, the preview restores focus inside the underlying asset browser');
  await assetCategory('All Assets', 'assets-browser-dialog');
  const assetDownload = await browser.evaluate<{ href: string; downloadable: boolean }>(`(() => { const link = document.querySelector(${JSON.stringify(`${browserGenerated} a[aria-label="Download image"]`)}); return {href: link?.getAttribute('href'), downloadable: link?.hasAttribute('download')}; })()`);
  assert.equal(assetDownload.downloadable, true, 'Assets exposes the saved image as a download');
  assert.equal(await browser.evaluate(`fetch(${JSON.stringify(assetDownload.href)}).then(response => response.status)`), 200, 'The asset download resolves to an available image');
  await browser.click(`${browserGenerated} button[aria-label=${JSON.stringify(`Open ${prompt}`)}]`);
  await browser.until("document.querySelector('#assets-output-viewer[open] [aria-label=\"Image zoom and pan\"] img')?.naturalWidth > 0", 'Clicking a generated asset opens its image preview');
  assert.equal(await browser.evaluate("!!document.querySelector('#reference-picker-dialog[open]') || !!document.querySelector('button[aria-label=\"Remove reference 1\"]')"), false, 'Opening an asset preview neither opens the picker nor attaches a reference');
  await assetPreviewFrame('assets-output-viewer');
  await browser.click('#assets-output-viewer button[aria-label="Close preview"]');
  await browser.until("!document.querySelector('#assets-output-viewer[open]') && !!document.querySelector('#assets-browser-dialog[open]')", 'Closing a generated preview returns to Assets');
  await uploadAsset();
  const uploadedAsset = store.inputs(store.owner()!.id).find(input => input.name === 'asset-management-upload.png')!;
  assert.ok(uploadedAsset, 'The library upload is saved through the real input API');
  assert.equal(store.inputs(store.owner()!.id).length, inputsBeforeBrowserUpload + 1);
  const browserImported = `#assets-browser-dialog article[data-asset-id="${uploadedAsset.id}"]`;
  await browser.click(`${browserImported} button[aria-label="Open asset-management-upload.png"]`);
  await browser.until("document.querySelector('#assets-input-viewer[open] img')?.naturalWidth > 0", 'Clicking an imported asset opens its image preview');
  assert.equal(await browser.evaluate("document.querySelector('#assets-input-viewer').innerText.includes('Imported image') && !Array.from(document.querySelectorAll('#assets-input-viewer dt')).some(label => label.textContent === 'Model')"), true, 'Imported previews identify the file without inventing generation metadata');
  await assetPreviewFrame('assets-input-viewer');
  await browser.click('#assets-input-viewer button[aria-label="Close preview"]');
  await browser.until("!document.querySelector('#assets-input-viewer[open]')", 'The imported preview closes');
  await browser.click(`${browserImported} button[aria-label="Delete image"]`);
  assert.equal(store.inputs(store.owner()!.id).some(input => input.id === uploadedAsset.id), true, 'The first imported-image delete click only arms the action');
  await browser.click(`${browserImported} button[aria-label="Confirm image deletion"]`);
  await browser.until(`!document.querySelector(${JSON.stringify(browserImported)})`, 'The second click removes the uploaded image from Assets');
  assert.equal(store.inputs(store.owner()!.id).some(input => input.id === uploadedAsset.id), false, 'Asset deletion removes the saved import');
  assert.equal(await browser.evaluate(`fetch(${JSON.stringify(uploadedAsset.url)}).then(response => response.status)`), 404, 'The deleted import file is no longer available');
  const disposableAssetJob = await browser.evaluate<{ id: string }>(`fetch('/api/jobs', {method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':'browser-disposable-asset'}, body:JSON.stringify({modelId:${JSON.stringify(modelId)},prompt:'Disposable asset browser output'})}).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body.job; })`);
  await browser.until("!!document.querySelector('#assets-browser-dialog article[data-source=generated] button[aria-label=\"Open Disposable asset browser output\"]')", 'New generated images appear in the open asset browser');
  const disposableOutput = store.job(disposableAssetJob.id).outputs[0];
  const disposableCard = `#assets-browser-dialog article[data-asset-id="${disposableOutput.id}"]`;
  await browser.click(`${disposableCard} button[aria-label="Delete image"]`);
  assert.equal(store.job(disposableAssetJob.id).outputs.length, 1, 'The first generated-image delete click only arms the action');
  await browser.click(`${disposableCard} button[aria-label="Confirm image deletion"]`);
  await browser.until(`!document.querySelector(${JSON.stringify(disposableCard)})`, 'The second click removes only the disposable generated image');
  assert.equal(store.job(disposableAssetJob.id).outputs.length, 0, 'Assets deletes generated output through the real owner API');
  assert.equal(store.job(first.id).outputs.length, 1, 'Deleting one asset preserves the earlier image');
  for (const mobile of [false, true]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 960, deviceScaleFactor: 1, mobile });
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    assert.equal(await browser.evaluate("(() => { const dialog = document.querySelector('#assets-browser-dialog'), rect = dialog.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth; })()"), true, 'The asset browser fits desktop and mobile without horizontal overflow');
    await browser.screenshot(join(output, `assets-browser-${mobile ? 'mobile' : 'desktop'}.png`));
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await assetCategory('Generated', 'assets-browser-dialog');
  await browser.fill('#assets-browser-dialog input[aria-label="Search assets"]', 'forest');
  await browser.evaluate("void (window.__gravityRetainedAssetBrowser = document.querySelector('#assets-browser-dialog'))");
  await dismissBackdrop('assets-browser-dialog');
  assert.equal(await browser.evaluate("document.activeElement?.getAttribute('aria-label')"), 'Assets', 'The asset browser returns focus to its topbar entry');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), assetBrowserDraft, 'Browsing, uploading and managing Assets preserves the unfinished prompt');
  assert.equal(await browser.evaluate("!!document.querySelector('button[aria-label=\"Remove reference 1\"]')"), false, 'Library uploads never attach themselves to the composer');
  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("document.querySelector('#reference-picker-dialog[open]')?.matches(':modal')", 'The dock opens its reference picker');
  await browser.evaluate("void (window.__gravityRetainedPicker = document.querySelector('#reference-picker-dialog'))");
  await browser.until("document.querySelectorAll('#reference-picker-dialog article[data-asset-id]').length === 2", 'Picker loads the generated output and previous import');
  assert.match(await browser.evaluate<string>("document.querySelector('#reference-picker-dialog nav[aria-label=\"Asset categories\"] button[aria-current=page]').textContent"), /^Image/);
  assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog input[aria-label=\"Search assets\"]').value"), '', 'The dock picker starts independently of the asset browser search');
  assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog').textContent.includes('Imported images')"), true, 'Undated inputs have an Imported images group');
  const generatedAsset = '#reference-picker-dialog article[data-source="generated"] button[aria-pressed]:not([data-favorite-action])';
  const importedAsset = '#reference-picker-dialog article[data-source="import"] button[aria-pressed]:not([data-favorite-action])';
  await browser.click(generatedAsset);
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', 'no-assets-match-this-query');
  await browser.until("!document.querySelector('#reference-picker-dialog article[data-asset-id]') && document.querySelector('#reference-picker-dialog').innerText.includes('No matching assets')", 'Search shows an explicit empty state');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#reference-picker-dialog button')).find(button => button.textContent.trim() === 'Use selected').disabled"), false, 'A selection survives being hidden by search');
  await browser.screenshot(join(output, 'assets-picker-empty-desktop.png'));
  await clickScopedText('#reference-picker-dialog', 'Clear selection');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#reference-picker-dialog button')).find(button => button.textContent.trim() === 'Use selected').disabled"), true, 'Clear selection removes assets hidden by the current filter');
  assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog input[aria-label=\"Search assets\"]').value"), 'no-assets-match-this-query', 'Clearing a hidden selection preserves the search');
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', '');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(generatedAsset)}).getAttribute('aria-pressed')`), 'false', 'The cleared asset stays unselected when its filter is removed');
  await browser.click(generatedAsset);
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(generatedAsset)}).getAttribute('aria-pressed')`), 'true', 'An explicitly cleared asset can be selected again');
  await assetCategory('Imports');
  assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog article[data-source=import]').length === 1 && !document.querySelector('#reference-picker-dialog article[data-source=generated]')"), true, 'Imports filters out generated images');
  await browser.click(importedAsset);
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', 'reference-upload');
  await dismissBackdrop('reference-picker-dialog');
  assert.equal(await browser.evaluate("document.activeElement?.getAttribute('aria-label')"), 'Browse saved images', 'Backdrop dismissal returns focus to the reference picker entry');
  await browser.click('header button[aria-label="Assets"]');
  await browser.until("!!document.querySelector('#assets-browser-dialog[open]')", 'Assets reopens after using the independent reference picker');
  assert.equal(await browser.evaluate("document.querySelector('#assets-browser-dialog') === window.__gravityRetainedAssetBrowser"), true, 'Assets keeps its own retained modal tree');
  assert.match(await browser.evaluate<string>("document.querySelector('#assets-browser-dialog nav button[aria-current=page]').textContent"), /^Generated/, 'Reference categories do not change the browser category');
  assert.equal(await browser.evaluate("document.querySelector('#assets-browser-dialog input[aria-label=\"Search assets\"]').value"), 'forest', 'Reference searches do not replace the browser query');
  assert.equal(await browser.evaluate("!!document.querySelector('#reference-picker-dialog[open]')"), false, 'Opening Assets leaves the reference picker closed');
  await browser.key('Escape');
  await browser.until("!document.querySelector('#assets-browser-dialog[open]')", 'Escape dismisses the asset browser');
  await browser.click('header button[aria-label="Assets"]');
  await browser.until("!!document.querySelector('#assets-browser-dialog[open]')", 'The asset browser reopens after Escape');
  assert.equal(await browser.evaluate("document.querySelector('#assets-browser-dialog input[aria-label=\"Search assets\"]').value"), 'forest', 'Escape retains the browser search');
  await browser.key('Escape');
  await browser.until("!document.querySelector('#assets-browser-dialog[open]')", 'The asset browser closes before resuming a reference selection');
  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("document.querySelector('#reference-picker-dialog[open]')?.matches(':modal')", 'The dock reopens its retained reference picker');
  assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog').length === 1 && document.querySelector('#reference-picker-dialog') === window.__gravityRetainedPicker"), true, 'The reference picker retains its modal tree');
  assert.match(await browser.evaluate<string>("document.querySelector('#reference-picker-dialog nav button[aria-current=page]').textContent"), /^Imports/, 'Backdrop dismissal preserves the asset category');
  assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog input[aria-label=\"Search assets\"]').value"), 'reference-upload', 'The dock restores the unfinished reference search');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(importedAsset)})?.getAttribute('aria-pressed')`), 'true', 'A picked import survives backdrop dismissal');
  await browser.key('Escape');
  await browser.until("!document.querySelector('#reference-picker-dialog[open]')", 'Escape dismisses the retained picker');
  assert.equal(await browser.evaluate("document.activeElement?.getAttribute('aria-label')"), 'Browse saved images', 'Escape returns focus to the current entry');
  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("!!document.querySelector('#reference-picker-dialog[open]')", 'The dock reopens its picker after Escape');
  assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog input[aria-label=\"Search assets\"]').value"), 'reference-upload', 'Escape preserves the asset query');
  assert.match(await browser.evaluate<string>("document.querySelector('#reference-picker-dialog nav button[aria-current=page]').textContent"), /^Imports/, 'Escape preserves the asset category');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(importedAsset)})?.getAttribute('aria-pressed')`), 'true', 'Escape preserves the selected import');
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', '');
  await assetCategory('All Assets');
  assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]:not([data-favorite-action])').length"), 1, 'A single-reference model replaces the previous selection');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(importedAsset)}).getAttribute('aria-pressed')`), 'true');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(generatedAsset)}).getAttribute('aria-pressed')`), 'false');
  await browser.click(generatedAsset);
  await assetCategory('Image');
  await assetPickerFrame(false);
  await browser.screenshot(join(output, 'assets-picker-desktop.png'));
  await clickScopedText('#reference-picker-dialog', 'Use selected');
  await browser.until("!document.querySelector('#reference-picker-dialog[open]') && !!document.querySelector('button[aria-label=\"Remove reference 1\"]')", 'Reference is uploaded');
  assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]:not([data-favorite-action])').length"), 0, 'A successful reference import clears its picker selection');
  await browser.fill('#image-prompt', 'Keep the composition and turn morning into twilight');
  await openAdvanced();
  await browser.fill('input[aria-label="Steps value"]', '24');
  await browser.fill('input[aria-label="Guidance value"]', '6.5');
  await browser.key('Escape');
  await browser.evaluate("void (window.__gravityQualityReference = document.querySelector('button[aria-label=\"Remove reference 1\"]'))");
  await openQuality();
  await browser.until("!!document.querySelector('[popover]:popover-open [aria-label=\"Quality Standard\"]')", 'Quality offers the Standard resolution for the reference generation');
  const referenceQualitySize = await browser.evaluate<{ width: number; height: number }>("(() => { const dimensions = document.querySelector('[popover]:popover-open [aria-label=\"Quality Standard\"]').textContent.match(/(\\d+) × (\\d+)/); return {width: Number(dimensions[1]), height: Number(dimensions[2])}; })()");
  await browser.key('Home');
  assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'), 'Quality Fast', 'Home focuses the first quality preset');
  await browser.key('ArrowDown');
  assert.equal(await browser.evaluate('document.activeElement?.getAttribute("aria-label")'), 'Quality Standard', 'Arrow keys move between quality presets');
  await browser.key('Enter');
  await browser.until("!!document.querySelector('button[aria-label=\"Quality: Standard\"]') && !document.querySelector('[popover]:popover-open')", 'Keyboard chooses Standard quality');
  assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Remove reference 1\"]') === window.__gravityQualityReference"), true, 'Changing quality preserves the selected reference');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), 'Keep the composition and turn morning into twilight', 'Changing quality preserves the prompt');
  await browser.clickText('Generate');
  await browser.until("document.querySelectorAll('button[aria-label=\"Open Browser checkpoint output\"]').length === 2", 'Reference generation completes');
  assert.equal(store.jobs(store.owner()!.id)[0].input.operation, 'image-to-image');
  const referenceGeneration = store.jobs(store.owner()!.id)[0];
  assert.deepEqual({ width: referenceGeneration.parameters.width, height: referenceGeneration.parameters.height, steps: referenceGeneration.parameters.steps, cfg: referenceGeneration.parameters.cfg }, { ...referenceQualitySize, steps: 24, cfg: 6.5 }, 'The real generation API receives the selected quality dimensions without changing custom steps or guidance');
  assert.ok(comfy.state.uploadBody.includes('filename='));
  const firstFigure = `figure:has(img[alt=${JSON.stringify(prompt)}])`;
  await browser.evaluate(`(() => {
    window.__gravityFavoriteFetch = window.fetch;
    window.__gravityFavoriteFailure = true;
    window.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (window.__gravityFavoriteFailure && url.origin === location.origin && url.pathname.endsWith('/favorite') && method === 'PUT') {
        window.__gravityFavoriteFailure = false;
        return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Favorite update interrupted.' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
      }
      return window.__gravityFavoriteFetch.call(window, input, options);
    };
  })()`);
  try {
    await browser.click(`${firstFigure} button[aria-label="Add to favorites"]`);
    await browser.until("Array.from(document.querySelectorAll('main [role=alert]')).some(alert => alert.textContent.includes('Favorite update interrupted.'))", 'Favorite failure has a visible explanation');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${firstFigure} button[aria-label="Add to favorites"]`)})?.getAttribute('aria-pressed')`), 'false', 'An unsuccessful update does not mark the output');
    assert.equal(await browser.evaluate("!!document.querySelector('#output-viewer[open]')"), false, 'The tile heart does not open the viewer');
    await browser.click(`${firstFigure} button[aria-label="Add to favorites"]`);
    await browser.until(`document.querySelector(${JSON.stringify(`${firstFigure} button[aria-label="Remove from favorites"]`)})?.getAttribute('aria-pressed') === 'true'`, 'Retry saves the favorite');
    await browser.until("!Array.from(document.querySelectorAll('main [role=alert]')).some(alert => alert.textContent.includes('Favorite update interrupted.'))", 'A successful retry clears the favorite error');
  } finally {
    await browser.evaluate('window.fetch = window.__gravityFavoriteFetch; delete window.__gravityFavoriteFetch; delete window.__gravityFavoriteFailure;');
  }
  const slowFavoritesScript = await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__gravitySlowFavoriteRead = { started: 0, aborted: 0, finished: false };
    window.__gravityBeforeSlowFavorites = window.fetch;
    window.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin === location.origin && url.pathname === '/api/favorites' && method === 'GET') {
        const stats = window.__gravitySlowFavoriteRead;
        if (++stats.started === 1) {
          const signal = options?.signal || (input instanceof Request ? input.signal : undefined);
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); stats.aborted++; stats.finished = true; reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); stats.finished = true; resolve(); }, 4200);
            if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
          });
        }
      }
      return window.__gravityBeforeSlowFavorites.call(window, input, options);
    };
  ` }) as unknown as { identifier: string };
  try {
    await browser.send('Page.reload');
    await browser.until("document.querySelectorAll('button[aria-label=\"Open Browser checkpoint output\"]').length === 2", 'Durable gallery after reload');
    await galleryFilter('Favorites');
    await browser.until('window.__gravitySlowFavoriteRead?.finished === true', 'Slow Favorites request finishes across a polling interval', 6000);
    assert.deepEqual(await browser.evaluate('window.__gravitySlowFavoriteRead'), { started: 1, aborted: 0, finished: true }, 'Polling keeps the pending favorite read instead of aborting or overlapping it');
    await browser.until(`document.querySelectorAll('main figure').length === 1 && !!document.querySelector(${JSON.stringify(firstFigure)})`, 'The slow response resolves Favorites loading with its saved output');
    await galleryFilter('All images');
    await browser.until("document.querySelectorAll('main figure').length === 2", 'All images restored after the delayed favorites response');
  } finally {
    await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slowFavoritesScript.identifier });
    await browser.evaluate('window.fetch = window.__gravityBeforeSlowFavorites; delete window.__gravityBeforeSlowFavorites; delete window.__gravitySlowFavoriteRead;');
  }
  await browser.until("document.querySelector('#image-prompt')?.value.includes('twilight') && !!document.querySelector('button[aria-label=\"Remove reference 1\"]')", 'Draft and references persist after reload');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${firstFigure} button[aria-label="Remove from favorites"]`)})?.getAttribute('aria-pressed')`), 'true', 'Favorite state persists after reload');
  await browser.evaluate("void (window.__gravityViewerState = { opener: document.querySelector('button[aria-label=\"Open Browser checkpoint output\"]'), prompt: document.querySelector('#image-prompt').value, reference: document.querySelector('button[aria-label=\"Remove reference 1\"]') })");
  await browser.click('[aria-label="Open Browser checkpoint output"]');
  await browser.until("document.querySelector('dialog[open][aria-label=\"Browser checkpoint output\"]')?.matches(':modal') && document.querySelector('[aria-label=\"Image zoom and pan\"] img')?.naturalWidth > 0", 'Output viewer opens with the image loaded');
  assert.equal(await browser.evaluate("document.querySelector('#output-viewer aside > header > [aria-hidden=true]')?.textContent"), 'B', 'An imported checkpoint uses its own initial when it has no publisher logo');
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
  await browser.click('#output-viewer details > summary');
  assert.equal(await browser.evaluate("document.querySelector('#output-viewer details').open"), false, 'Preview details can be collapsed');
  await browser.evaluate("void (window.__gravityRetainedPreview = { dialog: document.querySelector('#output-viewer'), top: document.querySelector('#output-viewer [aria-label=\"Image zoom and pan\"]').scrollTop })");
  const previewOutside = await browser.evaluate<{ x: number; y: number }>("(() => { const container = document.querySelector('#output-viewer [data-photo-action]').parentElement, rect = container.getBoundingClientRect(); return {x: rect.left + 2, y: rect.top + 2}; })()");
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...previewOutside, button: 'left', clickCount: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...previewOutside, button: 'left', clickCount: 1 });
  await browser.until("!document.querySelector('#output-viewer[open]')", 'Clicking outside the image dismisses its preview');
  await browser.click('button[aria-label="Open Browser checkpoint output"]');
  await browser.until("!!document.querySelector('#output-viewer[open]')", 'The same output preview reopens');
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  assert.equal(await browser.evaluate("document.querySelector('#output-viewer') === window.__gravityRetainedPreview.dialog"), true, 'The image preview retains its modal tree');
  assert.equal(await browser.evaluate("document.querySelector('#output-viewer [aria-label=\"Zoom level\"]').textContent"), '150%', 'Reopening the same image keeps its zoom');
  assert.equal(await browser.evaluate("document.querySelector('#output-viewer [aria-label=\"Image zoom and pan\"]').scrollTop === window.__gravityRetainedPreview.top"), true, 'Reopening the same image keeps its pan position');
  assert.equal(await browser.evaluate("document.querySelector('#output-viewer details').open"), false, 'Reopening the same image keeps Details collapsed');
  await browser.evaluate("document.querySelector('#output-viewer [aria-label=\"Image zoom and pan\"]').focus()");
  await browser.key('Escape');
  await browser.until("!!document.querySelector('dialog[open]') && document.querySelector('[aria-label=\"Zoom level\"]')?.textContent === 'Fit'", 'First Escape restores fit without closing the enlarged image');
  await browser.key('Escape');
  await browser.until("!document.querySelector('dialog[open]')", 'Output viewer Escape closes');
  assert.equal(await browser.evaluate('document.activeElement === window.__gravityViewerState.opener'), true, 'Closing the viewer restores focus to the opened gallery output');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value === window.__gravityViewerState.prompt && document.querySelector('button[aria-label=\"Remove reference 1\"]') === window.__gravityViewerState.reference"), true, 'Browsing and zooming preserve the unfinished prompt and reference');
  await browser.evaluate("Array.from(document.querySelectorAll('button[aria-label=\"Open Browser checkpoint output\"]')).find(button => button !== window.__gravityViewerState.opener).focus()");
  await browser.key('Enter');
  await browser.until(`document.querySelector('#output-viewer[open] [aria-label="Image zoom and pan"] img')?.src !== ${JSON.stringify(viewedSource)} && !!document.querySelector('#output-viewer[open]')`, 'Clicking a different gallery image replaces the retained preview');
  assert.equal(await browser.evaluate("document.querySelector('#output-viewer [aria-label=\"Zoom level\"]').textContent"), 'Fit', 'A different image starts fitted to the preview');
  await browser.click('#output-viewer details > summary');
  await browser.click('#output-viewer button[aria-label="Close preview"]');
  await browser.until("!document.querySelector('#output-viewer[open]')", 'The alternate output preview closes');
  await galleryFilter('Favorites');
  await browser.until(`document.querySelectorAll('main figure').length === 1 && !!document.querySelector(${JSON.stringify(firstFigure)})`, 'Favorites contains only the marked output');
  await browser.screenshot(join(output, 'favorites-desktop.png'));
  await browser.click(`${firstFigure} button[aria-label="Open Browser checkpoint output"]`);
  await browser.until("document.querySelector('#output-viewer[open] button[aria-label=\"Remove from favorites\"]')?.getAttribute('aria-pressed') === 'true'", 'The viewer shares the saved favorite state');
  await browser.click('#output-viewer button[aria-label="Remove from favorites"]');
  await browser.until("!document.querySelector('#output-viewer[open]') && !document.querySelector('main figure') && document.querySelector('main').innerText.includes('No favorites yet.')", 'Removing the last favorite closes its viewer and shows the empty state');
  assert.equal(await browser.evaluate("document.activeElement instanceof HTMLElement && document.activeElement !== document.body && document.activeElement.isConnected && document.activeElement.getClientRects().length > 0 && !document.activeElement.closest('dialog:not([open])')"), true, 'Removing the viewed favorite restores focus to a visible control');
  await galleryFilter('All images');
  await browser.until("document.querySelectorAll('main figure').length === 2", 'All images remains complete after unfavoriting');
  await browser.click(`${firstFigure} button[aria-label="Add to favorites"]`);
  await browser.until(`document.querySelector(${JSON.stringify(`${firstFigure} button[aria-label="Remove from favorites"]`)})?.getAttribute('aria-pressed') === 'true'`, 'Favorite restored for reference browsing');

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
  await assetCategory('Favorites');
  await browser.until(`document.querySelectorAll('#reference-picker-dialog article[data-asset-id]').length === 1 && !!document.querySelector('#reference-picker-dialog article[data-asset-id="${first.outputs[0].id}"]')`, 'Reference Favorites contains only the saved output');
  assert.equal(await browser.evaluate("!!document.querySelector('#reference-picker-dialog article[data-source=import]')"), false, 'Imported images do not appear in Favorites');
  await browser.click(generatedAsset);
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', 'no-favorite-matches-this-query');
  await browser.until("!document.querySelector('#reference-picker-dialog article[data-asset-id]') && document.querySelector('#reference-picker-dialog').innerText.includes('No matching assets')", 'Favorites supports search');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#reference-picker-dialog button')).find(button => button.textContent.trim() === 'Use selected').disabled"), false, 'Filtering preserves the selected favorite');
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', '');
  await assetCategory('Imports');
  await assetCategory('Favorites');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(generatedAsset)})?.getAttribute('aria-pressed')`), 'true', 'Favorite selection survives category changes');
  await browser.screenshot(join(output, 'assets-favorites-mobile.png'));
  await assetCategory('Image');
  await browser.click(generatedAsset);
  await assetPickerFrame(true);
  await browser.screenshot(join(output, 'assets-picker-mobile.png'));
  const pickedBeforeCancel = await browser.evaluate<string[]>("Array.from(document.querySelectorAll('#reference-picker-dialog article[data-asset-id]:has(button[aria-pressed=true]:not([data-favorite-action]))')).map(article => article.dataset.assetId)");
  assert.equal(pickedBeforeCancel.length, 1, 'Cancel preservation starts with a picked asset');
  await clickScopedText('#reference-picker-dialog', 'Cancel');
  await browser.until("!document.querySelector('#reference-picker-dialog[open]') && document.activeElement?.getAttribute('aria-label') === 'Browse saved images'", 'Cancel returns focus to Browse saved images');
  assert.equal(store.inputs(store.owner()!.id).length, importsBeforeCancel, 'Cancel does not upload a selected asset');
  assert.equal(await browser.evaluate("!!document.querySelector('button[aria-label=\"Remove reference 1\"]')"), false, 'Cancel leaves the composer references unchanged');
  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("!!document.querySelector('#reference-picker-dialog[open]')", 'The dock reopens a cancelled reference selection');
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('#reference-picker-dialog article[data-asset-id]:has(button[aria-pressed=true]:not([data-favorite-action]))')).map(article => article.dataset.assetId)"), pickedBeforeCancel, 'Cancel keeps the selection available for a later visit');
  await clickScopedText('#reference-picker-dialog', 'Cancel');
  await browser.click(`${firstFigure} button[aria-label="Remove from favorites"]`);
  await browser.until(`document.querySelector(${JSON.stringify(`${firstFigure} button[aria-label="Add to favorites"]`)})?.getAttribute('aria-pressed') === 'false'`, 'Favorite state restored before the remaining checks');
  assert.deepEqual(await browser.evaluate("fetch('/api/favorites').then(response => response.json()).then(body => body.jobs)"), [], 'The test leaves no saved favorites');
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
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  await browser.screenshot(join(output, 'image-topbar-320.png'));
  const compactHeader = await browser.evaluate<{ width: number; scrollWidth: number; buttons: Array<{ label: string; x: number; right: number; y: number; bottom: number; width: number; height: number }> }>("(() => { const header = document.querySelector('header'); return {width: header.clientWidth, scrollWidth: header.scrollWidth, buttons: ['Assets', 'Models', 'Settings'].map(label => { const rect = header.querySelector('button[aria-label=\"' + label + '\"]').getBoundingClientRect(); return {label, x: rect.left, right: rect.right, y: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height}; })}; })()");
  for (const label of ['Assets', 'Models', 'Settings']) {
    assert.equal(await browser.evaluate(`(() => { const button = document.querySelector('header button[aria-label="${label}"]'), rect = button.getBoundingClientRect(); return rect.width >= 36 && rect.height >= 36 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`), true, `${label} retains its 36px target and stays reachable in a 320px topbar: ${JSON.stringify(compactHeader)}`);
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('[role=tablist][aria-label=\"Settings sections\"] [role=tab]')).map(tab => tab.textContent.trim())"), ['GPUs', 'Generation', 'Assistant', 'Connections', 'Model files', 'Integrations', 'API access', 'App']);
  assert.equal(await browser.evaluate("!!document.querySelector('#settings-panel-integrations')"), false, 'Integration settings load only after selecting their tab');
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
  await settingsKey('ArrowDown', 'assistant');
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
  await settingsKey('End', 'app');
  await settingsKey('ArrowUp', 'api');
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
  // Fail one list request to exercise retry without contacting any external provider.
  await browser.evaluate("(() => { const originalFetch = window.fetch.bind(window); window.fetch = (input, init) => { if (String(input) === '/api/integrations' && !init?.method) { window.fetch = originalFetch; return Promise.resolve(new Response(JSON.stringify({error: {message: 'Integration list unavailable.'}}), {status: 503, headers: {'Content-Type': 'application/json'}})); } return originalFetch(input, init); }; })()");
  await browser.click('#settings-tab-api');
  await settingsKey('ArrowUp', 'integrations');
  await browser.until("document.querySelector('#settings-panel-integrations [role=alert]')?.textContent.includes('Integration list unavailable.')", 'Integration list failure is actionable');
  await clickScopedText('#settings-panel-integrations', 'Try again');
  await browser.until("document.querySelectorAll('#settings-panel-integrations form[aria-labelledby^=integration-] input[type=password]').length === 6", 'All six providers load after retry');
  const providerScope = 'form[aria-labelledby="integration-openai-title"]';
  const providerInput = `${providerScope} input[type=password]`;
  const originalProviderKey = 'browser-provider-key-ab12';
  const replacementProviderKey = 'browser-provider-key-cd34';
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(providerInput)}).getAttribute('autocomplete')`), 'off', 'Provider keys do not use saved browser credentials');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(providerInput)}).value`), '', 'Saved keys never populate the password input');
  await browser.fill(providerInput, originalProviderKey);
  await browser.click('#settings-tab-gpus');
  await browser.click('input[name="runtime-gpu"][value="amd:9700a"]');
  await browser.click('#settings-tab-integrations');
  const settingsScroll = await browser.evaluate<number>("(() => { const content = document.querySelector('#settings-panel-integrations').parentElement; content.scrollTop = Math.min(160, content.scrollHeight - content.clientHeight); return content.scrollTop; })()");
  assert.ok(settingsScroll > 0, 'Settings preservation uses real scrolled content');
  await browser.evaluate("window.__gravityDraftRefreshFetch = window.fetch; window.__gravityDraftRefreshes = { state: 0, settings: 0 }; window.fetch = async function(input, init) { const response = await window.__gravityDraftRefreshFetch.call(this, input, init); const url = new URL(input instanceof Request ? input.url : String(input), location.href); if (response.ok && (init?.method || 'GET') === 'GET') { if (url.pathname === '/api/state') window.__gravityDraftRefreshes.state++; if (url.pathname === '/api/settings') window.__gravityDraftRefreshes.settings++; } return response; }");
  try {
    await dismissBackdrop('settings-dialog');
    await browser.until('window.__gravityDraftRefreshes.state > 0', 'Studio polling continues while Settings is dismissed', 6000);
    await browser.click('header button[aria-label="Settings"]');
    await browser.until("document.querySelector('#settings-dialog[open]') && document.querySelector('#settings-tab-integrations')?.getAttribute('aria-selected') === 'true' && window.__gravityDraftRefreshes.settings > 0", 'Settings reopens Integrations and refreshes server configuration');
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(providerInput)}).value`), originalProviderKey, 'An unsaved provider key survives backdrop dismissal and server refresh');
    assert.equal(await browser.evaluate("document.querySelector('#settings-panel-integrations').parentElement.scrollTop"), settingsScroll, 'Settings reopens at the same content scroll position');
    assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation input[name=ramReserveGiB]').value"), '9', 'Polling preserves the unsaved RAM reserve');
    assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation input[name=vramReserveGiB]').value"), '1.5', 'Polling preserves the unsaved VRAM reserve');
    assert.equal(await browser.evaluate("document.querySelector('input[name=runtime-gpu][value=\"amd:9700a\"]').checked"), false, 'Refreshing on reopen preserves an unsaved GPU selection');
    assert.equal(await browser.evaluate(`JSON.stringify({...localStorage, ...sessionStorage}).includes(${JSON.stringify(originalProviderKey)})`), false, 'Preserved key drafts never enter browser storage');
    assert.deepEqual(store.settings().policy, savedPolicy, 'Closing and reopening Settings does not save its resource draft');
    assert.deepEqual(store.settings().workers.map(worker => worker.enabled), [true, true], 'Closing Settings does not apply the unchecked GPU');
  } finally {
    await browser.evaluate('window.fetch = window.__gravityDraftRefreshFetch; delete window.__gravityDraftRefreshFetch; delete window.__gravityDraftRefreshes;');
  }
  await browser.click('#settings-tab-gpus');
  await browser.click('input[name="runtime-gpu"][value="amd:9700a"]');
  await browser.click('#settings-tab-integrations');
  await clickScopedText(providerScope, 'Save key');
  await browser.until(`document.querySelector(${JSON.stringify(providerScope)}).textContent.includes('•••• ab12') && document.querySelector(${JSON.stringify(providerInput)}).value === ''`, 'Saving clears the raw key and shows its suffix');
  assert.equal(await browser.evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(originalProviderKey)})`), false, 'The saved raw key is absent from the DOM');
  const providerMetadata = await browser.evaluate<string>("fetch('/api/integrations').then(response => response.text())");
  assert.equal(providerMetadata.includes(originalProviderKey), false, 'Integration responses exclude saved raw keys');
  assert.equal(providerMetadata.includes('ab12'), true, 'Integration responses include the saved suffix');
  assert.equal(await browser.evaluate(`JSON.stringify({...localStorage, ...sessionStorage}).includes(${JSON.stringify(originalProviderKey)})`), false, 'Provider keys are absent from browser storage');
  await clickScopedText(providerScope, 'Check access');
  await browser.until(`(() => { const form = document.querySelector(${JSON.stringify(providerScope)}); const status = form.querySelector('[role=status]'); return status && status.textContent !== 'Key saved. Check access to verify it.' && form.getAttribute('aria-busy') === 'false'; })()`, 'Saved provider key passes its access check');
  assert.deepEqual(integrationRequests.at(-1), { url: 'https://api.openai.com/v1/models', authorization: `Bearer ${originalProviderKey}` }, 'The access check uses the saved server-side key');
  integrationResponseStatus = 401;
  await clickScopedText(providerScope, 'Check access');
  await browser.until(`!!document.querySelector(${JSON.stringify(providerScope)} + ' [role=alert]')`, 'Provider authentication failure is shown');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(providerScope)}).textContent.includes('•••• ab12') && document.querySelector(${JSON.stringify(providerInput)}).value === ''`), true, 'A failed access check preserves the saved key without revealing it');
  integrationResponseStatus = 200;
  await browser.fill(providerInput, 'invalid replacement key');
  await clickScopedText(providerScope, 'Replace key');
  await browser.until(`!!document.querySelector(${JSON.stringify(providerScope)} + ' [role=alert]')`, 'Invalid replacement key is rejected');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(providerScope)}).textContent.includes('•••• ab12') && document.querySelector(${JSON.stringify(providerInput)}).value === 'invalid replacement key'`), true, 'Failed replacement preserves both the saved key and the edit for correction');
  await browser.fill(providerInput, replacementProviderKey);
  await clickScopedText(providerScope, 'Replace key');
  await browser.until(`document.querySelector(${JSON.stringify(providerScope)}).textContent.includes('•••• cd34') && document.querySelector(${JSON.stringify(providerInput)}).value === ''`, 'Replacing a key updates its suffix and clears the field');
  await browser.screenshot(join(output, 'integrations-mobile.png'));
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-integrations').scrollWidth <= document.querySelector('#settings-panel-integrations').clientWidth"), true, 'Integration controls fit the mobile content area');
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
  await browser.fill('#settings-panel-generation input[name="ramReserveGiB"]', '11');
  await browser.click('button[aria-label="Close settings"]');
  await browser.until("!document.querySelector('#settings-dialog[open]')", 'Settings closes with a newer unsaved resource draft');
  assert.equal(await browser.evaluate("fetch('/api/settings').then(response => response.json()).then(settings => fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...settings, policy: {...settings.policy, ramReserveBytes: 10 * 1024 ** 3}})})).then(response => response.status)"), 200, 'Another settings client changes the saved revision while the modal is closed');
  await browser.evaluate("window.__gravityRevisionFetch = window.fetch; window.__gravityRevisionReads = 0; window.fetch = async function(input, init) { const response = await window.__gravityRevisionFetch.call(this, input, init); if (String(input) === '/api/settings' && !init?.method && response.ok) window.__gravityRevisionReads++; return response; }");
  try {
    await browser.click('header button[aria-label="Settings"]');
    await browser.until("!!document.querySelector('#settings-dialog[open]') && window.__gravityRevisionReads > 0", 'Reopening Settings reads the changed server revision');
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    assert.equal(await browser.evaluate("document.querySelector('#settings-panel-generation input[name=ramReserveGiB]').value"), '11', 'A newer server revision does not overwrite an unfinished resource draft');
    await clickScopedText('#settings-dialog', 'Discard changes');
    await browser.until("document.querySelector('#settings-panel-generation input[name=ramReserveGiB]')?.value === '10'", 'Discard refreshes the current server values instead of restoring a stale revision');
    await browser.fill('#settings-panel-generation input[name="ramReserveGiB"]', '9');
    await clickScopedText('#settings-dialog', 'Save settings');
    await browser.until("document.querySelector('#settings-dialog')?.innerText.includes('Configuration saved.')", 'A new edit saves successfully after discarding the stale draft');
    assert.equal(store.settings().policy.ramReserveBytes, 9 * 1024 ** 3, 'The recovered editor saves against the latest server revision');
    assert.equal(await browser.evaluate("!!document.querySelector('#settings-dialog [role=alert]')"), false, 'Discard recovery leaves no settings revision conflict');
  } finally { await browser.evaluate('window.fetch = window.__gravityRevisionFetch; delete window.__gravityRevisionFetch; delete window.__gravityRevisionReads;'); }
  await browser.click('button[aria-label="Close settings"]');
  await browser.until("!document.querySelector('#settings-dialog[open]')", 'Settings closes before reloading saved integrations');
  await browser.send('Page.reload');
  await browser.until("!!document.querySelector('#image-prompt')", 'Workspace reloads with integration credentials stored');
  await browser.click('header button[aria-label="Settings"]');
  await browser.click('#settings-tab-integrations');
  await browser.until(`document.querySelector(${JSON.stringify(providerScope)})?.textContent.includes('•••• cd34')`, 'Reloading restores only the saved suffix');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(providerInput)}).value`), '', 'Reloading never returns the saved raw key');
  assert.equal(await browser.evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(replacementProviderKey)})`), false, 'Reloading exposes no saved key in the DOM');
  await browser.click('[aria-label="Remove OpenAI (GPT) key"]');
  await browser.until(`document.querySelector(${JSON.stringify(providerScope)}).textContent.includes('No key saved')`, 'Removing a provider key clears its saved status');
  await browser.click('button[aria-label="Close settings"]');
  await browser.until("!document.querySelector('#settings-dialog[open]')", 'Settings closes after removing the key');

  const assistantScope = '[role="dialog"][aria-label="AI prompt assistant"]:popover-open';
  const textConnectionScope = 'form[aria-labelledby="text-connection-title"]';
  const assistantDraft = await browser.evaluate<string>("document.querySelector('#image-prompt').value");
  const originalAssistantPrompt = 'A ceramic teapot on an oak table.';
  const assistantJobs = store.jobs(store.owner()!.id).length;
  async function openAssistant() {
    await browser.click('button[aria-label="Open AI prompt assistant"]');
    await browser.until(`(() => { const panel = document.querySelector(${JSON.stringify(assistantScope)}); return panel && getComputedStyle(panel).visibility === 'visible' && !panel.textContent.includes('Loading assistant settings'); })()`, 'Prompt assistant opens with current settings');
    await browser.evaluate(`Promise.all([document.fonts.ready, ...document.querySelector(${JSON.stringify(assistantScope)}).getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`);
  }
  async function waitForTextRequest(previous: number) {
    for (let attempt = 0; attempt < 100 && textRequests === previous; attempt++) await delay(25);
    assert.equal(textRequests, previous + 1, 'The assistant dispatches exactly one provider request');
  }
  async function waitForTextAbort(expected: number) {
    for (let attempt = 0; attempt < 100 && textAborts < expected; attempt++) await delay(25);
    assert.equal(textAborts, expected, 'The browser cancellation reaches the provider request');
  }
  await browser.fill('#image-prompt', originalAssistantPrompt);
  await openAssistant();
  assert.match(await browser.evaluate<string>(`document.querySelector(${JSON.stringify(assistantScope)}).textContent`), /Choose a language model/, 'An unconfigured assistant gives a direct setup action');
  await clickScopedText(assistantScope, 'Choose assistant model');
  await browser.until("document.querySelector('#settings-dialog[open]') && document.querySelector('#settings-tab-assistant')?.getAttribute('aria-selected') === 'true'", 'The dock opens the Assistant settings section');
  await browser.click('#settings-tab-integrations');
  await browser.until("document.querySelector('input[aria-label=\"Text API base URL\"]')?.matches(':disabled') === false", 'The text connection form is ready');
  await browser.fill('input[aria-label="Text API base URL"]', 'http://127.0.0.1:18081/v1');
  await browser.fill('input[aria-label="Text endpoint API key"]', 'browser-text-key-ef56');
  await clickScopedText(textConnectionScope, 'Save connection');
  await browser.until(`document.querySelector(${JSON.stringify(textConnectionScope)}).textContent.includes('•••• ef56') && document.querySelector('input[aria-label="Text endpoint API key"]').value === ''`, 'Saving a text connection clears the raw key');
  assert.equal(await browser.evaluate("JSON.stringify({...localStorage, ...sessionStorage}).includes('browser-text-key-ef56')"), false, 'The compatible endpoint key never enters browser storage');
  await browser.click('#settings-tab-gpus');
  await browser.click('button[aria-label="Close settings"]');
  await browser.click('header button[aria-label="Models"]');
  await browser.click('#models-tab-language');
  await browser.until("document.querySelector('#models-panel-language select[aria-label=\"Language model provider\"]')?.matches(':disabled') === false", 'Language model selection loads');
  await browser.fill('#models-panel-language select[aria-label="Language model provider"]', 'openai-compatible');
  await clickScopedText('#models-panel-language', 'Manage connections');
  await browser.until("document.querySelector('#settings-dialog[open]') && !document.querySelector('#models-dialog[open]') && document.querySelector('#settings-tab-integrations')?.getAttribute('aria-selected') === 'true'", 'The Models shortcut opens Integrations over the previously selected GPU tab');
  await browser.click('button[aria-label="Close settings"]');
  await browser.click('header button[aria-label="Models"]');
  await browser.until("document.querySelector('#models-dialog[open]') && document.querySelector('#models-tab-language')?.getAttribute('aria-selected') === 'true'", 'Returning from connection settings preserves the Language model tab');
  await browser.fill('#models-panel-language select[aria-label="Language model provider"]', 'openai-compatible');
  await clickScopedText('#models-panel-language', 'Load models');
  await browser.until("!!document.querySelector('#models-panel-language select[aria-label=\"Assistant model\"] option[value=fixture-text]')", 'The compatible endpoint supplies discoverable models');
  await browser.fill('#models-panel-language select[aria-label="Assistant model"]', 'fixture-text');
  await clickScopedText('#models-panel-language', 'Use for assistant');
  await browser.until("document.querySelector('#models-panel-language [role=status]')?.textContent.includes('Assistant model saved')", 'Language model becomes the configured assistant');
  await browser.screenshot(join(output, 'language-models-mobile.png'));
  await browser.click('button[aria-label="Close models"]');
  await browser.click('header button[aria-label="Settings"]');
  await browser.click('#settings-tab-integrations');
  await browser.until("document.querySelector('input[aria-label=\"Text endpoint API key\"]')?.matches(':disabled') === false", 'Saved text connection is editable');
  await browser.fill('input[aria-label="Text endpoint API key"]', 'browser-text-key-ef56');
  await browser.click('#settings-tab-assistant');
  await browser.until("Array.from(document.querySelectorAll('#settings-panel-assistant button')).some(button => button.textContent.trim() === 'Disable assistant' && !button.matches(':disabled'))", 'The Assistant section reads the current language model');
  await clickScopedText('#settings-panel-assistant', 'Disable assistant');
  await browser.until("document.querySelector('#settings-panel-assistant [role=status]')?.textContent.includes('Prompt assistant disabled')", 'Changing the assistant increments the shared text revision');
  await browser.click('#settings-tab-integrations');
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  await browser.until("document.querySelector('input[aria-label=\"Text endpoint API key\"]')?.matches(':disabled') === false", 'Returning to Integrations refreshes the current revision');
  assert.equal(await browser.evaluate("document.querySelector('input[aria-label=\"Text endpoint API key\"]').value"), 'browser-text-key-ef56', 'Changing the assistant preserves an unsaved connection key');
  await clickScopedText(textConnectionScope, 'Save connection');
  await browser.until(`document.querySelector(${JSON.stringify(`${textConnectionScope} [role=status]`)})?.textContent.includes('Connection saved') && document.querySelector('input[aria-label="Text endpoint API key"]').value === ''`, 'The preserved connection edit saves without a stale revision error');
  assert.equal(await browser.evaluate(`!!document.querySelector(${JSON.stringify(`${textConnectionScope} [role=alert]`)})`), false, 'Switching sections does not leave a revision conflict');
  await browser.click('#settings-tab-assistant');
  await browser.until("document.querySelector('#settings-panel-assistant select[aria-label=\"Language model provider\"]')?.matches(':disabled') === false", 'Assistant settings refresh after the connection save');
  await browser.fill('#settings-panel-assistant select[aria-label="Language model provider"]', 'openai-compatible');
  await clickScopedText('#settings-panel-assistant', 'Load models');
  await browser.until("!!document.querySelector('#settings-panel-assistant select[aria-label=\"Assistant model\"] option[value=fixture-text]')", 'Assistant settings discovers the saved endpoint models');
  await browser.fill('#settings-panel-assistant select[aria-label="Assistant model"]', 'fixture-text');
  await clickScopedText('#settings-panel-assistant', 'Use for assistant');
  await browser.until("document.querySelector('#settings-panel-assistant [role=status]')?.textContent.includes('Assistant model saved')", 'The assistant is restored from Settings');
  await browser.click('button[aria-label="Close settings"]');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await openAssistant();
  assert.match(await browser.evaluate<string>(`document.querySelector(${JSON.stringify(assistantScope)}).textContent`), /Custom endpoint · fixture-text/, 'The dock identifies the inference source');
  await clickScopedText(assistantScope, 'Refine prompt');
  await browser.until(`document.querySelector('#image-prompt').value === ${JSON.stringify(assistantPrompt)}`, 'Refine replaces the draft with the provider result');
  await browser.until(`Array.from(document.querySelectorAll(${JSON.stringify(`${assistantScope} button`)})).some(button => button.textContent.trim() === 'Undo')`, 'An applied refinement exposes Undo');
  await browser.screenshot(join(output, 'prompt-assistant-desktop.png'));
  await clickScopedText(assistantScope, 'Undo');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), originalAssistantPrompt, 'Undo restores the exact original prompt');
  await clickScopedText(assistantScope, 'Rewrite');
  await browser.fill('textarea[aria-label="Rewrite instruction"]', 'Make it an evening scene.');
  assistantPrompt = 'A ceramic teapot on an oak table in the evening.';
  await browser.click('button[aria-label="Rewrite prompt"]');
  await browser.until(`document.querySelector('#image-prompt').value === ${JSON.stringify(assistantPrompt)}`, 'An instruction rewrites the current prompt');
  assert.match(await browser.evaluate<string>("document.querySelector('ol[aria-label=\"Prompt changes\"]').textContent"), /Make it an evening scene/, 'The assistant keeps the local instruction history');
  await browser.fill('#image-prompt', '');
  await browser.fill('textarea[aria-label="Rewrite instruction"]', 'A blue teapot in a sunlit kitchen.');
  assistantPrompt = 'A blue ceramic teapot in a sunlit kitchen.';
  await browser.click('button[aria-label="Rewrite prompt"]');
  await browser.until(`document.querySelector('#image-prompt').value === ${JSON.stringify(assistantPrompt)}`, 'An instruction can create the first draft from an empty prompt');
  await browser.fill('#image-prompt', 'My manual change after the assistant.');
  await browser.until(`!Array.from(document.querySelectorAll(${JSON.stringify(`${assistantScope} button`)})).some(button => button.textContent.trim() === 'Undo')`, 'Manual edits invalidate Undo so it cannot overwrite them');
  await clickScopedText(assistantScope, 'Refine');
  holdTextResponse = true;
  let previousTextRequests = textRequests;
  await clickScopedText(assistantScope, 'Refine prompt');
  await waitForTextRequest(previousTextRequests);
  assert.equal(await browser.evaluate("document.querySelector('button[title^=\"Submit to your generation queue\"]').disabled"), true, 'Generate is disabled while prompt refinement is in flight');
  await clickScopedText(assistantScope, 'Cancel');
  await browser.until("document.querySelector('button[title^=\"Submit to your generation queue\"]').disabled === false", 'Cancel releases the image composer');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), 'My manual change after the assistant.', 'Cancel preserves the original draft');
  await waitForTextAbort(1);
  finishTextResponse?.();
  previousTextRequests = textRequests;
  await clickScopedText(assistantScope, 'Refine prompt');
  await waitForTextRequest(previousTextRequests);
  await browser.fill('#image-prompt', 'Keep this edit made while the assistant was writing.');
  await browser.until(`document.querySelector(${JSON.stringify(`${assistantScope} [role=alert]`)})?.textContent.includes('Your prompt or image settings changed')`, 'Editing the draft cancels its pending refinement');
  await waitForTextAbort(2);
  finishTextResponse?.(); holdTextResponse = false;
  assert.equal(textAborts, 2, 'Both Cancel and changing the draft abort upstream work');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), 'Keep this edit made while the assistant was writing.', 'A late provider response cannot replace the edited draft');
  assert.equal(store.jobs(store.owner()!.id).length, assistantJobs, 'Refining does not submit an image generation job');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.until('document.documentElement.clientWidth === 390', 'Assistant mobile viewport');
  await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  assert.equal(await browser.evaluate(`(() => { const panel = document.querySelector(${JSON.stringify(assistantScope)}), rect = panel.getBoundingClientRect(); return rect.width <= 366 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && panel.scrollWidth <= panel.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })()`), true, 'The prompt assistant fits a narrow viewport');
  await browser.screenshot(join(output, 'prompt-assistant-mobile.png'));
  await browser.key('Escape');
  await browser.fill('#image-prompt', assistantDraft);

  await browser.click('header button[aria-label="Models"]');
  await browser.click('#models-tab-language');
  await browser.until("document.querySelector('#models-panel-language select[aria-label=\"Language model provider\"]')?.matches(':disabled') === false", 'Language models opens before local setup');
  await browser.fill('#models-panel-language select[aria-label="Language model provider"]', 'local');
  const localScope = '#models-panel-language section[aria-label="Local language model"]';
  await browser.until(`document.querySelector(${JSON.stringify(localScope)})?.textContent.includes(${JSON.stringify(LOCAL_TEXT_MODEL.name)})`, 'The bundled MiMo model appears in Local Studio');
  assert.equal(await browser.evaluate("document.querySelector('#models-panel-language select[aria-label=\"Language model provider\"]').value"), 'local');
  assert.equal(await browser.evaluate("!!document.querySelector('#models-panel-language input[type=url]')"), false, 'Managed local models require no manual endpoint URL');
  assert.equal(await browser.evaluate("document.querySelector('#models-panel-language input[aria-label=\"Use Studio GPUs automatically\"]').checked"), true, 'Local models follow Studio GPUs by default');
  await browser.click('#models-panel-language input[aria-label="Use Studio GPUs automatically"]');
  await browser.until("document.querySelectorAll('#models-panel-language input[type=checkbox][name=local-text-gpu]:checked').length === 2", 'An override exposes both detected GPUs as checked boxes');
  await browser.click('#models-panel-language input[name="local-text-gpu"][value="amd:9700a"]');
  await clickScopedText(localScope, 'Download model');
  await browser.until(`!!document.querySelector(${JSON.stringify(`${localScope} progress`)})`, 'The model download starts from the panel');
  assert.deepEqual(localState.gpuIds, ['amd:9700b'], 'Download automatically saves the chosen GPU override');
  assert.equal(localPreparations, 1, 'One click starts exactly one managed setup');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#models-panel-language button')).some(button => button.textContent.trim() === 'Use for assistant')"), false, 'The local model cannot be selected while it is still downloading');
  localState.download!.receivedBytes = LOCAL_TEXT_MODEL.sizeBytes / 2;
  await browser.until(`document.querySelector(${JSON.stringify(`${localScope} progress`)})?.value === 50`, 'Download progress is refreshed from the server');
  await browser.screenshot(join(output, 'local-language-download-mobile.png'));
  await browser.click('button[aria-label="Close models"]');
  assert.equal(localState.busy, true, 'Closing Models leaves managed setup running');
  await browser.click('header button[aria-label="Models"]');
  await browser.click('#models-tab-language');
  await browser.until("document.querySelector('#models-panel-language select[aria-label=\"Language model provider\"]')?.matches(':disabled') === false", 'Language model controls reopen during setup');
  await browser.fill('#models-panel-language select[aria-label="Language model provider"]', 'local');
  await browser.until(`document.querySelector(${JSON.stringify(`${localScope} progress`)})?.value === 50`, 'Reopening Models restores the ongoing download');
  assert.equal(localPreparations, 1, 'Reopening the modal does not restart setup');
  Object.assign(localState, { phase: 'ready', ready: true, installed: true, busy: false, download: null, message: 'MiMo is ready.' });
  await browser.until("Array.from(document.querySelectorAll('#models-panel-language button')).some(button => button.textContent.trim() === 'Use for assistant' && !button.matches(':disabled'))", 'The installed and prepared model becomes selectable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await modelFrame(false);
  await browser.evaluate("document.querySelectorAll('#models-dialog, #models-dialog *').forEach(element => { if (getComputedStyle(element).overflowY === 'auto') element.scrollTop = 0; })");
  await browser.screenshot(join(output, 'local-language-ready-desktop.png'));
  await clickScopedText('#models-panel-language', 'Use for assistant');
  await browser.until("Array.from(document.querySelectorAll('#models-panel-language [role=status]')).some(status => status.textContent.includes('Assistant model saved'))", 'MiMo is saved through the real assistant settings API');
  assert.deepEqual(await browser.evaluate("fetch('/api/text/settings').then(response => response.json()).then(settings => settings.assistant)"), { provider: 'local', modelId: LOCAL_TEXT_MODEL.id });
  await browser.click('button[aria-label="Close models"]');
  await browser.fill('#image-prompt', originalAssistantPrompt);
  await openAssistant();
  assert.match(await browser.evaluate<string>(`document.querySelector(${JSON.stringify(assistantScope)}).textContent`), /Local Studio · mimo-v2.6-distill-qwen-9b/, 'The dock identifies the managed local provider');
  assistantPrompt = 'A ceramic teapot on an oak table in a bright kitchen.';
  await clickScopedText(assistantScope, 'Refine prompt');
  await browser.until(`document.querySelector('#image-prompt').value === ${JSON.stringify(assistantPrompt)}`, 'The real refinement service uses the managed local endpoint');
  assert.equal(localRuns, 1);
  assert.equal(localState.phase, 'loaded', 'An idle local model remains loaded after a successful request');
  assert.equal(localState.gpuId, 'amd:9700b', 'The local runtime uses the saved GPU selection');
  assert.equal(store.jobs(store.owner()!.id).length, assistantJobs, 'Local refinement does not create image jobs');
  await browser.key('Escape');
  await browser.click('header button[aria-label="Models"]');
  await browser.click('#models-tab-language');
  await browser.until(`document.querySelector(${JSON.stringify(localScope)})?.textContent.includes('Loaded on GPU 2')`, 'Language models reports resident GPU usage');
  assert.equal(await browser.evaluate("document.querySelector('#models-panel-language select[aria-label=\"Language model provider\"]').value"), 'local', 'The saved local provider is selected when Models reopens');
  await modelFrame(false);
  await browser.screenshot(join(output, 'local-language-loaded-desktop.png'));
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await modelFrame(true);
  await browser.screenshot(join(output, 'local-language-loaded-mobile.png'));
  localUnloadFails = true;
  await clickScopedText(localScope, 'Unload from GPU');
  await browser.until(`Array.from(document.querySelectorAll(${JSON.stringify(`${localScope} button`)})).some(button => button.textContent.trim() === 'Retry unload')`, 'A failed stop keeps a visible retry action');
  assert.equal(localState.gpuId, 'amd:9700b', 'A failed stop preserves the resident GPU allocation');
  await clickScopedText(localScope, 'Retry unload');
  await browser.until(`document.querySelector(${JSON.stringify(localScope)})?.textContent.includes('Ready to use') && !document.querySelector(${JSON.stringify(`${localScope} [role=alert]`)})`, 'Retry confirms the model stopped and clears its error');
  assert.equal(localState.gpuId, null); assert.equal(localReleases, 2);
  await browser.click('#models-panel-language input[aria-label="Use Studio GPUs automatically"]');
  await clickScopedText(localScope, 'Apply GPU selection');
  await browser.until(`document.querySelector(${JSON.stringify(localScope)})?.textContent.includes('GPU selection saved')`, 'An installed model can return to automatic Studio GPU selection');
  assert.deepEqual(localState.gpuIds, []);
  await browser.click('button[aria-label="Close models"]');
  Object.assign(localState, { phase: 'loaded', gpuId: 'amd:9700b', busy: false });
  const statusReadsBefore = localStatusReads;
  await openActivity();
  const unloadAssistant = `${activityScope} button[aria-label="Unload ${LOCAL_TEXT_MODEL.name}"]`;
  await browser.until(`document.querySelector(${JSON.stringify(unloadAssistant)})?.disabled === false`, 'Activity discovers the resident local assistant without opening Models');
  assert.ok(localStatusReads > statusReadsBefore, 'Opening activity reads managed local runtime status');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${activityScope} [aria-label="GPU 2 · AMD Radeon AI PRO R9700"]`)})?.textContent.includes(${JSON.stringify(LOCAL_TEXT_MODEL.name)})`), true, 'The assistant appears on its assigned physical GPU');
  Object.assign(localState, { phase: 'running', busy: true });
  await browser.until(`!document.querySelector(${JSON.stringify(`${unloadAssistant}:not(:disabled)`)})`, 'Open activity polls the runtime and prevents unloading an active text request');
  assert.equal(localReleases, 2, 'Polling a busy assistant never unloads it');
  Object.assign(localState, { phase: 'failed', busy: false, error: 'Could not confirm the local model stopped. Retry unloading it.' });
  await browser.until(`document.querySelector(${JSON.stringify(unloadAssistant)})?.disabled === false && document.querySelector(${JSON.stringify(activityScope)})?.textContent.includes('Could not confirm')`, 'A failed stop preserves a visible resident model and a retryable unload action');
  await browser.click(unloadAssistant);
  await browser.until(`!document.querySelector(${JSON.stringify(unloadAssistant)})`, 'Confirmed unload removes the assistant from resident GPU models');
  assert.equal(localReleases, 3); assert.equal(localState.gpuId, null);
  await browser.click('button[aria-label="Close activity"]');
  // Give any in-flight read a chance to settle before checking the closed panel.
  await delay(100);
  const closedStatusReads = localStatusReads;
  await delay(3300);
  assert.equal(localStatusReads, closedStatusReads, 'Closing activity stops its local runtime polling');
  await browser.fill('#image-prompt', assistantDraft);
  const privateKeyDraft = 'browser-private-unsaved-key-gh78';
  await browser.click('header button[aria-label="Settings"]');
  await browser.click('#settings-tab-integrations');
  await browser.until(`document.querySelector(${JSON.stringify(providerInput)})?.matches(':disabled') === false`, 'Provider form is ready for the logout draft');
  await browser.fill(providerInput, privateKeyDraft);
  await browser.key('Escape');
  await browser.until("!document.querySelector('#settings-dialog[open]')", 'Settings closes with an unsaved private key');
  await browser.click('header button[aria-label="Models"]');
  await browser.click('#models-tab-huggingface');
  await browser.fill('input[name="checkpoint-url"]', 'https://huggingface.co/gravity-fixtures/private-draft/blob/main/model.safetensors');
  await browser.fill('input[name="checkpoint-name"]', 'Private unsaved checkpoint');
  await browser.key('Escape');
  await browser.until("!document.querySelector('#models-dialog[open]')", 'Models closes with an unsaved checkpoint');
  await browser.click('button[aria-label="Remove reference 1"]');
  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("!!document.querySelector('#reference-picker-dialog[open] article[data-source=import]')", 'The reference picker opens before session cleanup');
  await assetCategory('Imports');
  await browser.click(importedAsset);
  await browser.fill('#reference-picker-dialog input[aria-label="Search assets"]', 'private-reference-query');
  await clickScopedText('#reference-picker-dialog', 'Cancel');
  await browser.click('header button[aria-label="Assets"]');
  await browser.until("!!document.querySelector('#assets-browser-dialog[open] article[data-source=generated]')", 'Assets opens before session cleanup');
  await browser.click('#assets-browser-dialog article[data-source=generated] button[aria-label^="Open "]');
  await browser.until("!!document.querySelector('#assets-output-viewer[open]')", 'An asset preview is retained before signing out');
  await browser.click('#assets-output-viewer button[aria-label="Close preview"]');
  await browser.until("!document.querySelector('#assets-output-viewer[open]')", 'The asset preview closes before signing out');
  await assetCategory('Generated', 'assets-browser-dialog');
  await browser.fill('#assets-browser-dialog input[aria-label="Search assets"]', 'twilight');
  await browser.key('Escape');
  await browser.until("!document.querySelector('#assets-browser-dialog[open]')", 'Assets closes with an unfinished search');
  await browser.click('button[aria-label="Open Browser checkpoint output"]');
  await browser.until("!!document.querySelector('#output-viewer[open]')", 'An image preview is retained before signing out');
  await browser.click('#output-viewer button[aria-label="Close preview"]');
  await browser.until("!document.querySelector('#output-viewer[open]')", 'The preview is closed before signing out');
  const privateModalSelector = '#settings-dialog, #models-dialog, #reference-picker-dialog, #output-viewer, #assets-browser-dialog, #assets-output-viewer, #assets-input-viewer, #account-panel';
  await browser.evaluate(`void (window.__gravityPrivateModals = Array.from(document.querySelectorAll(${JSON.stringify(privateModalSelector)})).filter(dialog => dialog.id !== 'account-panel'))`);
  assert.equal(await browser.evaluate('window.__gravityPrivateModals.length'), 6, 'Each visited private modal is retained while the owner is signed in');
  await browser.click('[aria-label="Account"]');
  await browser.until("!!document.querySelector('#account-panel[open]')", 'The account drawer opens before signing out');
  await browser.evaluate("window.__gravityPrivateModals.push(document.querySelector('#account-panel'))");
  await browser.clickText('Sign out');
  await browser.until("document.body.innerText.includes('Welcome back.')", 'Signed out');
  assert.equal(await browser.evaluate(`document.querySelectorAll(${JSON.stringify(privateModalSelector)}).length`), 0, 'Signing out removes every private modal from the DOM');
  assert.equal(await browser.evaluate('window.__gravityPrivateModals.every(dialog => !dialog.isConnected)'), true, 'Signing out unmounts retained modal trees');
  assert.equal(await browser.evaluate(`JSON.stringify({...localStorage, ...sessionStorage}).includes(${JSON.stringify(privateKeyDraft)})`), false, 'Signing out leaves no unsaved provider key in browser storage');
  await browser.fill('input[name="username"]', 'browser-owner');
  await browser.fill('input[name="password"]', 'test-password-strong-123');
  await browser.clickText('Sign in');
  await browser.until("!!document.querySelector('#image-prompt') && !document.querySelector('dialog[open]')", 'Owner signs back into the Image workspace');
  await browser.click('header button[aria-label="Settings"]');
  await browser.until("document.querySelector('#settings-tab-gpus')?.getAttribute('aria-selected') === 'true'", 'A new session starts Settings on GPUs');
  await browser.click('#settings-tab-integrations');
  await browser.until(`document.querySelector(${JSON.stringify(providerInput)})?.matches(':disabled') === false`, 'Fresh session integration controls load');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(providerInput)}).value`), '', 'Signing in does not restore the previous private key draft');
  await browser.click('button[aria-label="Close settings"]');
  await browser.click('header button[aria-label="Models"]');
  await browser.until("document.querySelector('#models-tab-library')?.getAttribute('aria-selected') === 'true'", 'A new session starts Models in Library');
  await browser.click('#models-tab-huggingface');
  assert.equal(await browser.evaluate("document.querySelector('input[name=checkpoint-url]').value"), '', 'Signing in clears the previous checkpoint URL draft');
  assert.equal(await browser.evaluate("document.querySelector('input[name=checkpoint-name]').value"), '', 'Signing in clears the previous checkpoint name draft');
  await browser.click('button[aria-label="Close models"]');
  await browser.click('header button[aria-label="Assets"]');
  await browser.until("!!document.querySelector('#assets-browser-dialog[open]')", 'Fresh session Assets opens');
  assert.match(await browser.evaluate<string>("document.querySelector('#assets-browser-dialog nav button[aria-current=page]').textContent"), /^All Assets/, 'Signing in resets the asset browser category');
  assert.equal(await browser.evaluate("document.querySelector('#assets-browser-dialog input[aria-label=\"Search assets\"]').value"), '', 'Signing in clears the previous browser search');
  await browser.key('Escape');
  await browser.until("!document.querySelector('#assets-browser-dialog[open]')", 'Fresh Assets closes before checking the separate picker');
  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("!!document.querySelector('#reference-picker-dialog[open]')", 'The reference picker opens fresh after signing in');
  assert.match(await browser.evaluate<string>("document.querySelector('#reference-picker-dialog nav button[aria-current=page]').textContent"), /^Image/, 'Signing in resets the previous asset category');
  assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog input[aria-label=\"Search assets\"]').value"), '', 'Signing in clears the previous asset search');
  assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]:not([data-favorite-action])').length"), 0, 'A new session begins without picked assets');
  await clickScopedText('#reference-picker-dialog', 'Cancel');
  for (const label of ['Models', 'Settings']) {
    await browser.navigate(`${origin}/${label.toLowerCase()}`);
    await browser.until(`!!document.querySelector('#${label.toLowerCase()}-dialog[open]') && !!document.querySelector('#image-prompt')`, `${label} entry URL opens its dialog over Image`);
    await browser.click(`button[aria-label="Close ${label.toLowerCase()}"]`);
    await browser.until("!document.querySelector('dialog[open]') && !!document.querySelector('#image-prompt')", `${label} entry dialog closes to Image`);
  }

  // Read-only UI fixture: expose real catalog manifests as selectable without
  // installing their weights. No generation is submitted while readiness is overridden.
  const geometryModels = [
    { id: 'wai-illustrious-v17', name: 'WAI Illustrious v17', short: 'wai', defaultQuality: 'High' },
    { id: 'flux-2-klein-4b', name: 'FLUX.2 Klein 4B', short: 'klein', defaultQuality: 'Standard' },
    { id: 'krea-2-turbo', name: 'Krea 2 Turbo', short: 'krea', defaultQuality: 'Fast' },
    { id: 'qwen-image-2.1', name: 'Qwen Image 2.1', short: 'qwen', defaultQuality: 'Fast' },
    { id: 'ideogram-4-fp8', name: 'Ideogram 4 FP8', short: 'ideogram', defaultQuality: 'Fast' },
    { id: 'sdxl-base', name: 'SDXL Base 1.0 with an unusually long checkpoint name that must remain readable in the model menu', short: 'long', defaultQuality: 'High' },
  ];
  const draftKey = `gravity:image-draft:${store.owner()!.id}`;
  const savedDraft = await browser.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(draftKey)})`);
  const jobCount = store.jobs(store.owner()!.id).length;
  const submissionCount = comfy.state.submissions.length;
  const geometryPrompt = 'Keep this exact prompt while switching between image model families.';
  const dockSelectors = {
    dock: '[data-workspace-scroll="dock"]', prompt: '#image-prompt',
    model: 'button[aria-label^="Model:"]', aspect: 'button[aria-label^="Aspect ratio:"]', quality: 'button[aria-label^="Quality:"]',
    background: 'button[aria-label^="Background:"]',
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
        if (url.origin !== location.origin || (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET' || !response.ok) return response;
        if (url.pathname === '/api/state' && (window.__gravityViewerBrandFixture || window.__gravityWideGalleryFixture)) {
          const state = await response.json();
          state.jobs = state.jobs.map(job => job.outputs.length ? { ...job,
            ...(window.__gravityViewerBrandFixture ? { modelId: 'qwen-image-2.1', modelName: 'Qwen Image 2.1' } : {}),
            ...(window.__gravityWideGalleryFixture ? { outputs: job.outputs.map(output => ({ ...output, width: 2560, height: 1024 })) } : {}),
          } : job);
          return new Response(JSON.stringify(state), { status: response.status, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.pathname !== '/api/catalog') return response;
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
    const qualityCatalog = await browser.evaluate<Array<{ id: string; defaults: { width: number; height: number; steps: number; cfg: number }; dimensions: { min: number; max: number; multiple: number; maxPixels: number }; qualityPresets: Array<{ id: string; pixels: number }> }>>("fetch('/api/catalog').then(response => response.json()).then(catalog => catalog.models)");
    for (const viewport of [{ name: 'desktop', width: 1440, height: 960, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
      let dockBaseline: Geometry | undefined;
      let advancedBaseline: Geometry | undefined;
      const intrinsicWidths: Array<{ width: number; textWidth: number }> = [];
      await browser.evaluate("void (window.__gravityGeometryPrompt = document.querySelector('#image-prompt'))");
      for (const model of geometryModels) {
        await selectGeometryModel(model.name);
        const bounds = await geometry(dockSelectors);
        const stable = Object.fromEntries(Object.entries(bounds).filter(([name]) => !['model', 'aspect', 'quality', 'background'].includes(name)));
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
        } else if (!viewport.mobile) {
          assert.ok(label.scrollWidth <= label.clientWidth + 1, 'Ordinary model names fit their natural chip width');
          intrinsicWidths.push({ width: bounds.model.width, textWidth: label.textWidth });
        }
        assert.ok(bounds.aspect.width > 44 && bounds.aspect.width < 80, 'The aspect chip fits its icon and label without a fixed width');
        assert.ok(bounds.quality.width > 60 && bounds.quality.width < 120 && Math.abs(bounds.quality.height - 36) < .1, 'Quality fits its label at the same height as the other chips');
        assert.ok(Math.abs(bounds.quality.x - bounds.aspect.x - bounds.aspect.width - 6) < .1, 'Quality sits immediately to the right of the aspect ratio with a 6px gap');
        assert.ok(Math.abs(bounds.quality.y - bounds.aspect.y) < .1 && Math.abs(bounds.quality.y - bounds.model.y) < .1, 'Model, aspect ratio and Quality share one row');
        assert.ok(bounds.background.width > 60 && bounds.background.width <= 156 && Math.abs(bounds.background.height - 36) < .1, 'Background uses a compact chip at the same height');
        assert.ok(Math.abs(bounds.background.x - bounds.quality.x - bounds.quality.width - 6) < .1 && Math.abs(bounds.background.y - bounds.quality.y) < .1, 'Background immediately follows Quality in the same control group');
        if (viewport.mobile) {
          assert.equal(await browser.evaluate(`(() => {
            const model = document.querySelector('button[aria-label^="Model:"]'), aspect = document.querySelector('button[aria-label^="Aspect ratio:"]'), quality = document.querySelector('button[aria-label^="Quality:"]');
            const row = model.parentElement.parentElement, visible = row.getBoundingClientRect();
            return row.scrollLeft === 0 && [model, aspect, quality].every(button => { const rect = button.getBoundingClientRect(); return rect.left >= visible.left - 1 && rect.right <= visible.right + 1 && rect.left >= 0 && rect.right <= innerWidth; });
          })()`), true, `${model.name}: the model, Auto and Quality controls are fully visible without scrolling on mobile`);
          assert.ok(bounds.advanced.y >= bounds.model.y + bounds.model.height, 'Mobile assistant and advanced actions use their own row');
          assert.ok(Math.abs(bounds.generate.height - 64) < .1, 'Wrapping mobile actions preserves the fixed Generate height');
        }
        assert.ok(Math.abs(bounds.model.height - 36) < .1); assert.ok(Math.abs(bounds.aspect.height - 36) < .1);
        for (const action of ['add', 'browse']) { assert.ok(Math.abs(bounds[action].width - 40) < .1); assert.ok(Math.abs(bounds[action].height - 40) < .1); }
        assert.equal(await browser.evaluate(`document.querySelector('#image-prompt') === window.__gravityGeometryPrompt && document.querySelector('#image-prompt').value === ${JSON.stringify(geometryPrompt)}`), true, 'Model changes preserve the same prompt element and text');
        const noReferences = ['krea', 'ideogram'].includes(model.short);
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
        assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(dockSelectors.quality)}).getAttribute('aria-label')`), `Quality: ${model.defaultQuality}`, `${model.name}: model selection restores its default quality`);
        await openQuality();
        await browser.until("!!document.querySelector('[popover]:popover-open [aria-label=\"Quality High\"]')", `${model.name} quality menu opens`);
        const presets = await browser.evaluate<Array<{ label: string; current: boolean; disabled: boolean; width: number; height: number }>>("Array.from(document.querySelectorAll('[popover]:popover-open [role=menuitem][aria-label^=\"Quality \"]')).map(row => { const dimensions = row.textContent.match(/(\\d+) × (\\d+)/); return {label: row.getAttribute('aria-label'), current: row.getAttribute('aria-current') === 'true', disabled: row.disabled, width: Number(dimensions?.[1]), height: Number(dimensions?.[2])}; })");
        const qualityModel = qualityCatalog.find(entry => entry.id === model.id)!;
        assert.deepEqual(presets.map(preset => preset.label), ['Quality Fast', 'Quality Standard', 'Quality High'], `${model.name} offers all three resolution presets`);
        assert.deepEqual(presets.filter(preset => preset.current).map(preset => preset.label), [`Quality ${model.defaultQuality}`]);
        for (const [index, preset] of presets.entries()) {
          assert.equal(preset.disabled, false, `${model.name}: ${preset.label} is available`);
          for (const side of [preset.width, preset.height]) assert.ok(side >= qualityModel.dimensions.min && side <= qualityModel.dimensions.max && side % qualityModel.dimensions.multiple === 0, `${model.name}: ${preset.label} respects the model grid`);
          assert.ok(preset.width * preset.height <= qualityModel.dimensions.maxPixels, `${model.name}: ${preset.label} stays inside the sampling budget`);
          if (index) assert.ok(preset.width * preset.height > presets[index - 1].width * presets[index - 1].height, `${model.name} quality choices have distinct, increasing resolutions`);
        }
        if (['krea', 'qwen', 'ideogram'].includes(model.short)) assert.deepEqual({ width: presets[2].width, height: presets[2].height }, { width: 2048, height: 2048 }, `${model.name} High exposes its full 4 MP square canvas`);
        await screenshotPopover(`quality-${model.short}-${viewport.name}.png`);
        assert.equal(await browser.evaluate("(() => { const menu = document.querySelector('[popover]:popover-open'), rect = menu.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1 && menu.scrollWidth <= menu.clientWidth; })()"), true, `${model.name} quality menu fits ${viewport.name}`);
        if (!viewport.mobile) {
          await browser.click('[popover]:popover-open [aria-label="Quality High"]');
          await browser.until("!!document.querySelector('button[aria-label=\"Quality: High\"]') && !document.querySelector('[popover]:popover-open')", 'Choosing High closes the menu');
          assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(dockSelectors.quality)}).title`), `Quality: High · ${presets[2].width} × ${presets[2].height}`, `${model.name}: High applies the dimensions advertised by the menu`);
          await browser.click(dockSelectors.aspect);
          await browser.click('[popover]:popover-open [aria-label="Aspect ratio 16:9"]');
          await browser.until("!!document.querySelector('button[aria-label=\"Aspect ratio: 16:9\"]') && !document.querySelector('[popover]:popover-open')", 'A shape change keeps High quality');
          assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(dockSelectors.quality)}).getAttribute('aria-label')`), 'Quality: High', `${model.name}: changing aspect preserves quality`);
          await openQuality();
          await browser.click('[popover]:popover-open [aria-label="Quality Fast"]');
          await browser.until("!!document.querySelector('button[aria-label=\"Quality: Fast\"]') && !document.querySelector('[popover]:popover-open')", 'A quality change keeps the selected shape');
          assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(dockSelectors.aspect)}).getAttribute('aria-label')`), 'Aspect ratio: 16:9', `${model.name}: changing quality preserves aspect`);
          await openAdvanced();
          const qualityValues = await browser.evaluate<{ width: number; height: number; steps: number; cfg: number }>("Object.fromEntries(['Width', 'Height', 'Steps', 'Guidance'].map(label => [label === 'Guidance' ? 'cfg' : label.toLowerCase(), Number(document.querySelector('[popover]:popover-open input[aria-label=\"' + label + ' value\"]').value)]))");
          assert.ok(Math.abs(qualityValues.width / qualityValues.height / (16 / 9) - 1) <= .02, `${model.name}: selected quality dimensions retain the widescreen shape`);
          assert.deepEqual({ steps: qualityValues.steps, cfg: qualityValues.cfg }, { steps: qualityModel.defaults.steps, cfg: qualityModel.defaults.cfg }, `${model.name}: quality leaves the sampler settings unchanged`);
          assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), geometryPrompt, 'Quality and aspect choices preserve the prompt');
          await browser.key('Escape');
          await browser.click(dockSelectors.reset);
          await browser.until(`!!document.querySelector('button[aria-label=${JSON.stringify(`Quality: ${model.defaultQuality}`)}]') && document.querySelector(${JSON.stringify(dockSelectors.reset)}).disabled`, `${model.name}: reset restores default quality and dimensions`);
        } else await browser.key('Escape');
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
      if (!viewport.mobile) {
        assert.ok(Math.max(...intrinsicWidths.map(item => item.width)) - Math.min(...intrinsicWidths.map(item => item.width)) > 8, 'Shorter and longer model names have different chip widths');
        const chromeWidth = intrinsicWidths[0].width - intrinsicWidths[0].textWidth;
        for (const measured of intrinsicWidths) assert.ok(Math.abs(measured.width - measured.textWidth - chromeWidth) <= 2, 'Chip width follows its model label while retaining consistent icon spacing');
      }
    }
    await browser.evaluate("window.__gravityViewerBrandFixture = true; document.dispatchEvent(new Event('visibilitychange'));");
    await browser.until("!!document.querySelector('button[aria-label=\"Open Qwen Image 2.1 output\"]')", 'The visual viewer fixture uses a known model publisher');
    for (const mobile of [false, true]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 960, deviceScaleFactor: 1, mobile });
      await browser.click('button[aria-label="Open Qwen Image 2.1 output"]');
      await browser.until("document.querySelector('#output-viewer[open] [aria-label=\"Image zoom and pan\"] img')?.naturalWidth > 0", 'Qwen viewer image loaded');
      assert.equal(await browser.evaluate("document.querySelector('#output-viewer aside > header > [aria-hidden=true]')?.style.maskImage.includes('/brands/qwen.svg')"), true, 'The viewer uses the selected model publisher logo');
      await browser.screenshot(join(output, `output-viewer-qwen-${mobile ? 'mobile' : 'desktop'}.png`));
      await browser.click('#output-viewer button[aria-label="Close preview"]');
      await browser.until("!document.querySelector('#output-viewer[open]')", 'Qwen visual fixture viewer closes');
    }
    const savedGalleryZoom = await browser.evaluate<string>("document.querySelector('input[aria-label=\"Image tile size\"]').value");
    await browser.evaluate("delete window.__gravityViewerBrandFixture; window.__gravityWideGalleryFixture = true; document.dispatchEvent(new Event('visibilitychange'));");
    await browser.click('button[aria-label="Justified image layout"]');
    await browser.fill('input[aria-label="Image tile size"]', '0');
    for (const mobile of [false, true]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 960, deviceScaleFactor: 1, mobile });
      await browser.until("Array.from(document.querySelectorAll('main figure')).length === 2 && Array.from(document.querySelectorAll('main figure')).every(figure => { const rect = figure.getBoundingClientRect(); return rect.width > rect.height * 2 && rect.height <= 150.5; })", 'Wide output tiles render at the minimum gallery size');
      const buttons = await browser.evaluate<Array<{ label: string; fits: boolean }>>("Array.from(document.querySelectorAll('main figure')).flatMap(figure => { const frame = figure.getBoundingClientRect(); return Array.from(figure.querySelectorAll('button:not([aria-label^=Open]), a')).map(button => { const rect = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), fits: rect.width > 0 && rect.height > 0 && rect.left >= frame.left - .5 && rect.top >= frame.top - .5 && rect.right <= frame.right + .5 && rect.bottom <= frame.bottom + .5 }; }); })");
      assert.equal(buttons.length, 8, 'Both saved outputs expose all four gallery actions');
      assert.ok(buttons.every(button => button.fits), `${mobile ? 'Mobile' : 'Desktop'} actions fit inside short, wide tiles: ${JSON.stringify(buttons)}`);
      const point = await browser.evaluate<{ x: number; y: number }>("(() => { const rect = document.querySelector('main figure').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()");
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await browser.evaluate("new Promise(resolve => requestAnimationFrame(resolve)).then(() => Promise.all(document.querySelector('main figure').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))).then(() => true)");
      await browser.screenshot(join(output, `gallery-actions-wide-minimum-${mobile ? 'mobile' : 'desktop'}.png`));
    }
    await browser.fill('input[aria-label="Image tile size"]', savedGalleryZoom);
    await browser.evaluate("delete window.__gravityWideGalleryFixture; document.dispatchEvent(new Event('visibilitychange'));");
    await browser.until("!!document.querySelector('button[aria-label=\"Open Browser checkpoint output\"]')", 'Real output model restored after the logo fixture');
    await selectGeometryModel('FLUX.2 Klein 4B');
    await uploadReference();
    await browser.click('button[aria-label="Browse saved images"]');
    await browser.until("document.querySelectorAll('#reference-picker-dialog article[data-asset-id]').length >= 4", 'Multi-reference picker loads more assets than its remaining capacity');
    const choices = await browser.evaluate<string[]>("Array.from(document.querySelectorAll('#reference-picker-dialog article[data-asset-id]')).slice(0, 4).map(article => article.dataset.assetId)");
    const choice = (id: string) => `#reference-picker-dialog article[data-asset-id="${id}"] button[aria-pressed]:not([data-favorite-action])`;
    for (const id of choices.slice(0, 3)) await browser.click(choice(id));
    assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]:not([data-favorite-action])').length"), 3, 'Klein allows three more selections beside its existing reference');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(choice(choices[3]))}).disabled`), true, 'The remaining asset is blocked when the model capacity is full');
    await browser.click(choice(choices[0]));
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(choice(choices[3]))}).disabled`), false, 'Deselecting frees one slot');
    await browser.click(choice(choices[0]));
    await assetCategory('All Assets');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 500, deviceScaleFactor: 1, mobile: true });
    await browser.until("(() => { const gallery = document.querySelector('#reference-picker-dialog [aria-label=\"Asset gallery\"]'); return gallery.scrollHeight > gallery.clientHeight; })()", 'The mobile asset gallery has real overflow');
    const assetScroll = await browser.evaluate<number>("(() => { const gallery = document.querySelector('#reference-picker-dialog [aria-label=\"Asset gallery\"]'); gallery.scrollTop = Math.min(120, gallery.scrollHeight - gallery.clientHeight); return gallery.scrollTop; })()");
    assert.ok(assetScroll > 0, 'Asset scroll preservation uses a nonzero position');
    await dismissBackdrop('reference-picker-dialog');
    await browser.click('button[aria-label="Browse saved images"]');
    await browser.until("!!document.querySelector('#reference-picker-dialog[open]')", 'The dock resumes its scrolled reference selection');
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog [aria-label=\"Asset gallery\"]').scrollTop"), assetScroll, 'Backdrop dismissal preserves the gallery scroll position');
    assert.match(await browser.evaluate<string>("document.querySelector('#reference-picker-dialog nav button[aria-current=page]').textContent"), /^All Assets/, 'Reopening a scrolled picker keeps its category');
    assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]:not([data-favorite-action])').length"), 3, 'All chosen references survive reopening the picker');
    await browser.key('Escape');
    await browser.until("!document.querySelector('#reference-picker-dialog[open]')", 'Escape dismisses the scrolled asset picker');
    await browser.click('button[aria-label="Browse saved images"]');
    await browser.until("!!document.querySelector('#reference-picker-dialog[open]')", 'The dock resumes the same scrolled selection');
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    assert.equal(await browser.evaluate("document.querySelector('#reference-picker-dialog [aria-label=\"Asset gallery\"]').scrollTop"), assetScroll, 'Escape preserves the asset gallery scroll position');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
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
      assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]:not([data-favorite-action])').length"), 3, 'A failed upload keeps all selected assets for retry');
      await browser.screenshot(join(output, 'assets-picker-error-mobile.png'));
    } finally { await browser.evaluate('window.fetch = window.__gravityPickerFetch; delete window.__gravityPickerFetch'); }
    await clickScopedText('#reference-picker-dialog', 'Use selected');
    await browser.until("!document.querySelector('#reference-picker-dialog[open]') && document.querySelectorAll('button[aria-label^=\"Remove reference \"]').length === 4", 'Retry adds the entire selected batch and closes the picker');
    assert.equal(await browser.evaluate("document.querySelectorAll('#reference-picker-dialog button[aria-pressed=true]:not([data-favorite-action])').length"), 0, 'Only successful batch confirmation clears the retained selection');
    assert.equal(await browser.evaluate("document.querySelector('button[aria-label=\"Browse saved images\"]').disabled"), true, 'A full model cannot open another reference selection');
    assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), geometryPrompt, 'Adding several references preserves the prompt');
    await browser.clickText('Remove all');
    assert.equal(store.jobs(store.owner()!.id).length, jobCount, 'The geometry fixture creates no generation jobs');
    assert.equal(comfy.state.submissions.length, submissionCount, 'The geometry fixture submits no ComfyUI prompts');
  } finally {
    await browser.evaluate(`(() => { if (window.__gravityOriginalFetch) { window.fetch = window.__gravityOriginalFetch; delete window.__gravityOriginalFetch; } delete window.__gravityGeometryPrompt; delete window.__gravityUnavailableModel; delete window.__gravityViewerBrandFixture; delete window.__gravityWideGalleryFixture; ${savedDraft === null ? `localStorage.removeItem(${JSON.stringify(draftKey)});` : `localStorage.setItem(${JSON.stringify(draftKey)}, ${JSON.stringify(savedDraft)});`} })()`);
    await browser.send('Page.reload');
    await browser.until("!!document.querySelector('button[aria-label=\"Model: Browser checkpoint\"]')", 'Real catalog and saved draft restored after the geometry fixture');
  }
  assert.equal(await browser.evaluate(`fetch('/api/catalog').then(response => response.json()).then(catalog => catalog.models.filter(model => ${JSON.stringify(geometryModels.map(model => model.id))}.includes(model.id)).every(model => !model.ready))`), true, 'Real readiness is restored after the UI-only fixture');
  await browser.click('[aria-label="Open Browser checkpoint output"]');
  await browser.until("!!document.querySelector('#output-viewer[open]')", 'Reopen an output to reuse its settings');
  await clickScopedText('#output-viewer', 'Use these settings');
  await browser.until("!document.querySelector('#output-viewer[open]') && document.activeElement === document.querySelector('#image-prompt')", 'Reusing settings closes the viewer and focuses the composer');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), store.jobs(store.owner()!.id).find(job => job.outputs.length)!.prompt, 'Reuse restores the selected output prompt');
  const deletionUrl = await browser.evaluate<string>(`document.querySelector(${JSON.stringify(`${firstFigure} > img`)}).getAttribute('src')`);
  const preservedImages = await browser.evaluate<string[]>(`Array.from(document.querySelectorAll('main figure > img')).map(image => image.getAttribute('src')).filter(url => url !== ${JSON.stringify(deletionUrl)})`);
  assert.equal(preservedImages.length, 1, 'Delete regression starts with two saved images');
  await browser.click(`${firstFigure} button[aria-label="Add to favorites"]`);
  await browser.until(`document.querySelector(${JSON.stringify(`${firstFigure} button[aria-label="Remove from favorites"]`)})?.getAttribute('aria-pressed') === 'true'`, 'The image to delete is also a favorite');
  await browser.evaluate(`(() => {
    window.__gravityBeforeDelete = window.fetch;
    window.__gravityDeleteRequests = 0;
    window.__gravityDeleteFailure = true;
    window.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin === location.origin && url.pathname === ${JSON.stringify(`/api/jobs/${first.id}/outputs/${first.outputs[0].id}`)} && method === 'DELETE') {
        window.__gravityDeleteRequests++;
        if (window.__gravityDeleteFailure) {
          window.__gravityDeleteFailure = false;
          return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Image deletion interrupted.' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
        }
      }
      return window.__gravityBeforeDelete.call(window, input, options);
    };
  })()`);
  const deleteButton = `${firstFigure} button[aria-label="Delete image"]`;
  const confirmDeleteButton = `${firstFigure} button[aria-label="Confirm image deletion"]`;
  async function armDelete() {
    await browser.until(`document.querySelector(${JSON.stringify(deleteButton)})?.disabled === false`, 'The image is ready for deletion');
    await browser.click(deleteButton);
    await browser.until(`document.querySelector(${JSON.stringify(confirmDeleteButton)})?.disabled === false`, 'The first click arms the same image action for confirmation');
    assert.equal(await browser.evaluate("!!document.querySelector('[popover]:popover-open, dialog[open]')"), false, 'Arming deletion opens no dialog or popover');
  }
  try {
    for (const mobile of [false, true]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 960, deviceScaleFactor: 1, mobile });
      await armDelete();
      assert.equal(await browser.evaluate('window.__gravityDeleteRequests'), 0, 'The first click sends no DELETE request');
      await browser.evaluate(`new Promise(resolve => requestAnimationFrame(resolve)).then(() => { const animations = []; for (let element = document.querySelector(${JSON.stringify(confirmDeleteButton)}); element; element = element.parentElement) animations.push(...element.getAnimations()); return Promise.all(animations.map(animation => animation.finished.catch(() => {}))); }).then(() => true)`);
      await browser.screenshot(join(output, `gallery-delete-armed-${mobile ? 'mobile' : 'desktop'}.png`));
      if (mobile) await browser.click('#image-prompt'); else await browser.key('Escape');
      await browser.until(`!!document.querySelector(${JSON.stringify(deleteButton)}) && !document.querySelector(${JSON.stringify(confirmDeleteButton)})`, `${mobile ? 'Moving focus away' : 'Escape'} cancels the armed action`);
      assert.equal(await browser.evaluate('window.__gravityDeleteRequests'), 0, 'Cancelling an armed action sends no DELETE request');
    }
    assert.equal(await browser.evaluate(`!!document.querySelector(${JSON.stringify(firstFigure)})`), true, 'Cancel leaves the image in the gallery');
    await armDelete();
    assert.equal(await browser.evaluate('window.__gravityDeleteRequests'), 0, 'Rearming still requires a separate confirmation click');
    await browser.click(confirmDeleteButton);
    await browser.until("Array.from(document.querySelectorAll('main [role=alert]')).some(alert => alert.textContent.includes('Image deletion interrupted.'))", 'A failed deletion has a visible gallery error');
    await browser.until(`document.querySelector(${JSON.stringify(deleteButton)})?.disabled === false && !document.querySelector(${JSON.stringify(confirmDeleteButton)})`, 'Failure resets the action to its trash icon');
    assert.equal(await browser.evaluate('window.__gravityDeleteRequests'), 1);
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${firstFigure} button[aria-label="Remove from favorites"]`)})?.getAttribute('aria-pressed')`), 'true', 'Failure preserves the output and its favorite');
    assert.equal(store.job(first.id).outputs.length, 1, 'Failure preserves the saved output record');
    await armDelete();
    assert.equal(await browser.evaluate('window.__gravityDeleteRequests'), 1, 'A failed attempt must be armed again before retrying');
    await browser.click(confirmDeleteButton);
    await browser.until(`!document.querySelector(${JSON.stringify(firstFigure)}) && document.querySelectorAll('main figure').length === 1`, 'The second click removes only the confirmed image');
    assert.equal(await browser.evaluate('window.__gravityDeleteRequests'), 2);
    assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('main figure > img')).map(image => image.getAttribute('src'))"), preservedImages, 'Other generated outputs remain visible');
    assert.equal(await browser.evaluate(`fetch(${JSON.stringify(deletionUrl)}).then(response => response.status)`), 404, 'The deleted output file is unavailable');
    assert.deepEqual(await browser.evaluate("fetch('/api/favorites').then(response => response.json()).then(body => body.jobs)"), [], 'Deleting an image also removes its favorite');
    assert.equal(store.job(first.id).status, 'succeeded', 'The generation record remains available');
    assert.deepEqual(store.job(first.id).outputs, [], 'Only the selected output is removed from the generation record');
    assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('main p')).some(element => element.textContent.trim() === ${JSON.stringify(prompt)})`), false, 'A completed job with no remaining images has no placeholder tile');
  } finally {
    await browser.evaluate('window.fetch = window.__gravityBeforeDelete; delete window.__gravityBeforeDelete; delete window.__gravityDeleteRequests; delete window.__gravityDeleteFailure;');
  }
  await browser.send('Page.reload');
  await browser.until("document.querySelectorAll('main figure').length === 1 && !!document.querySelector('#image-prompt')", 'Output deletion persists after reload');
  assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('main figure > img')).map(image => image.getAttribute('src'))"), preservedImages);
  assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('main p')).some(element => element.textContent.trim() === ${JSON.stringify(prompt)})`), false, 'Reload does not recreate a succeeded placeholder for the deleted image');

  // Browser permission, sound and OS delivery are deterministic fixtures; the
  // production worker, notification controls and real job transitions are not.
  const alertMocks = await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__gravityAlertStats = JSON.parse(sessionStorage.getItem('browser-alert-stats') || '{"permissions":0,"gestures":[],"notifications":[],"sounds":0}');
    const save = () => sessionStorage.setItem('browser-alert-stats', JSON.stringify(window.__gravityAlertStats));
    const record = (title, options) => { window.__gravityAlertStats.notifications.push({title, options}); save(); };
    class TestNotification {
      static get permission() { return sessionStorage.getItem('browser-notification-permission') || 'default'; }
      static async requestPermission() { window.__gravityAlertStats.permissions++; window.__gravityAlertStats.gestures.push(navigator.userActivation.isActive); sessionStorage.setItem('browser-notification-permission', 'granted'); save(); return 'granted'; }
      constructor(title, options) { record(title, options); }
      close() {}
    }
    Object.defineProperty(window, 'Notification', {configurable:true, value:TestNotification});
    if ('ServiceWorkerRegistration' in window) ServiceWorkerRegistration.prototype.showNotification = async (title, options) => record(title, options);
    const parameter = () => ({value:0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}});
    class TestAudioContext {
      currentTime = 0; state = 'running'; destination = {};
      async resume() {} async close() {}
      createGain() { return {gain:parameter(), connect(target) {return target;}, disconnect() {}}; }
      createOscillator() { return {frequency:parameter(), connect(target) {return target;}, disconnect() {}, start() {window.__gravityAlertStats.sounds++; save();}, stop() {}}; }
    }
    Object.defineProperty(window, 'AudioContext', {configurable:true, value:TestAudioContext});
    window.__gravityBackground = true;
    Object.defineProperty(document, 'visibilityState', {configurable:true, get:() => window.__gravityBackground ? 'hidden' : 'visible'});
    Object.defineProperty(document, 'hidden', {configurable:true, get:() => window.__gravityBackground});
  ` }) as unknown as { identifier: string };
  try {
    await browser.send('Page.reload');
    await browser.until("!!document.querySelector('header button[aria-label=\"Notifications\"]') && document.querySelectorAll('main figure').length === 1", 'Notification controls mount around restored job history');
    await browser.until('!!navigator.serviceWorker.controller', 'The production service worker controls Studio');
    assert.deepEqual(await browser.evaluate('window.__gravityAlertStats'), { permissions: 0, gestures: [], notifications: [], sounds: 0 }, 'Opening Studio does not ask for permission or replay old completions');
    assert.deepEqual(await browser.evaluate("Array.from(document.querySelectorAll('link[rel=manifest]'), link => ({path:new URL(link.href).pathname, credentials:link.crossOrigin}))"), [{ path: '/manifest.webmanifest', credentials: 'use-credentials' }], 'The install manifest includes authentication cookies for an HTTPS access proxy');
    const browserManifest = await browser.send('Page.getAppManifest') as unknown as { data: string; errors: unknown[] };
    assert.deepEqual(browserManifest.errors, [], 'Chromium accepts the served application manifest');
    assert.equal(JSON.parse(browserManifest.data).name, 'Gravity Studio');
    await browser.evaluate("window.__gravityBackground = false; document.dispatchEvent(new Event('visibilitychange'))");
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await browser.click('header button[aria-label="Notifications"]');
    const notifications = '[role="dialog"][aria-label="Notifications"]:popover-open';
    const soundSwitch = `${notifications} [role="switch"][aria-label="Play a sound when a generation is ready"]`;
    const desktopSwitch = `${notifications} [role="switch"][aria-label="Show a desktop notification when a generation is ready"]`;
    await browser.until(`!!document.querySelector(${JSON.stringify(notifications)})`, 'Notification popover opens');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(soundSwitch)}).getAttribute('aria-checked')`), 'false');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(desktopSwitch)}).getAttribute('aria-checked')`), 'false');
    await browser.click(soundSwitch);
    await browser.until('window.__gravityAlertStats.sounds > 0', 'Enabling sound previews a chime after a user gesture');
    await browser.evaluate("window.__gravitySetStorage = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {if (key === 'gravity:completion-alerts') throw new DOMException('Storage is full', 'QuotaExceededError'); return window.__gravitySetStorage.call(this, key, value);}");
    try {
      await browser.click(soundSwitch);
      await browser.until(`document.querySelector(${JSON.stringify(soundSwitch)}).getAttribute('aria-checked') === 'false'`, 'A full browser store still permits an in-memory preference change');
    } finally {
      await browser.evaluate('Storage.prototype.setItem = window.__gravitySetStorage; delete window.__gravitySetStorage');
    }
    await browser.click(soundSwitch);
    await browser.until(`document.querySelector(${JSON.stringify(soundSwitch)}).getAttribute('aria-checked') === 'true'`, 'A subsequent preference edit persists when browser storage recovers');
    await browser.click(desktopSwitch);
    await browser.until(`document.querySelector(${JSON.stringify(desktopSwitch)}).getAttribute('aria-checked') === 'true'`, 'Desktop notifications enable after permission is granted');
    assert.equal(await browser.evaluate('window.__gravityAlertStats.permissions'), 1, 'Permission is requested once from the desktop switch');
    assert.deepEqual(await browser.evaluate('window.__gravityAlertStats.gestures'), [true], 'The permission request retains the trusted user activation');
    assert.deepEqual(await browser.evaluate('window.__gravityAlertStats.notifications'), [], 'Granting permission does not notify about old history');
    await delay(450);
    await screenshotPopover('notifications-desktop.png');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await browser.until(`(() => { const panel = document.querySelector(${JSON.stringify(notifications)}), rect = panel.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && panel.scrollWidth <= panel.clientWidth; })()`, 'Notification popover fits a phone viewport');
    await screenshotPopover('notifications-mobile.png');
    await browser.click('button[aria-label="Close notifications"]');
    await browser.click('header button[aria-label="Settings"]');
    await browser.click('#settings-tab-app');
    await browser.until("document.querySelector('#settings-panel-app')?.innerText.includes('App on this device')", 'App settings opens inside the existing settings modal');
    assert.equal(await browser.evaluate(`(() => {
      window.__gravityInstallStats = {prompts:0, gestures:[]};
      const event = new Event('beforeinstallprompt', {cancelable:true});
      event.prompt = async () => {window.__gravityInstallStats.prompts++; window.__gravityInstallStats.gestures.push(navigator.userActivation.isActive);};
      event.userChoice = Promise.resolve({outcome:'accepted'});
      window.dispatchEvent(event); return event.defaultPrevented;
    })()`), true, 'Studio retains the browser install invitation without opening it automatically');
    await browser.until("Array.from(document.querySelectorAll('#settings-panel-app button')).some(button => button.textContent === 'Install Gravity Studio')", 'An install-capable browser exposes its explicit install action');
    assert.equal(await browser.evaluate('window.__gravityInstallStats.prompts'), 0, 'An install invitation needs an explicit user choice');
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('#settings-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)");
    assert.equal(await browser.evaluate("document.querySelector('#settings-panel-app').scrollWidth <= document.querySelector('#settings-panel-app').clientWidth && document.documentElement.scrollWidth <= innerWidth"), true, 'App settings fits its mobile panel');
    await browser.screenshot(join(output, 'settings-app-mobile.png'));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await browser.screenshot(join(output, 'settings-app-desktop.png'));
    await clickScopedText('#settings-panel-app', 'Install Gravity Studio');
    await browser.until('window.__gravityInstallStats.prompts === 1', 'Clicking Install opens the browser-owned installation prompt once');
    assert.deepEqual(await browser.evaluate('window.__gravityInstallStats.gestures'), [true], 'The install action runs within its user gesture');
    assert.equal(await browser.evaluate("document.querySelector('#settings-panel-app').innerText.includes('Gravity Studio is installed on this device.')"), false, 'Accepting a prompt alone is not reported as a completed installation');
    await browser.evaluate("window.dispatchEvent(new Event('appinstalled'))");
    await browser.until("document.querySelector('#settings-panel-app').innerText.includes('Gravity Studio is installed on this device.')", 'Only the installation event confirms the app was installed');
    const updateDraft = await browser.evaluate<string>("document.querySelector('#image-prompt').value");
    await browser.evaluate("window.__gravityUpdatePrompt = document.querySelector('#image-prompt'); navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))");
    await browser.until("Array.from(document.querySelectorAll('#settings-panel-app button')).some(button => button.textContent === 'Reload app')", 'A service-worker change offers an explicit reload');
    assert.equal(await browser.evaluate("document.querySelector('#image-prompt') === window.__gravityUpdatePrompt"), true, 'An update does not reload or remount the unfinished composer');
    await clickScopedText('#settings-panel-app', 'Reload app');
    await browser.until(`document.querySelector('#image-prompt')?.value === ${JSON.stringify(updateDraft)} && !window.__gravityUpdatePrompt`, 'An explicit app reload restores the saved prompt');
    await browser.evaluate("window.__gravityBackground = false; document.dispatchEvent(new Event('visibilitychange'))");
    const previewSounds = await browser.evaluate<number>('window.__gravityAlertStats.sounds');
    completeAutomatically = false;
    comfy.state.postBehavior = 'normal';
    otherComfy.state.postBehavior = 'normal';
    const notifiedJob = await browser.evaluate<{ id: string }>(`fetch('/api/jobs', {method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':'browser-notification-completion'}, body:JSON.stringify({modelId:${JSON.stringify(modelId)},prompt:'A small green ceramic bowl for the completion notification test'})}).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body.job; })`);
    await browser.until("document.querySelector('[data-server-activity]')?.dataset.state === 'running'", 'The browser observes the pending generation before completion');
    await browser.evaluate("window.__gravityBackground = true; document.dispatchEvent(new Event('visibilitychange'))");
    completeAutomatically = true;
    await browser.until('window.__gravityAlertStats.notifications.length === 1', 'Completing a known job sends one notification while Studio is in the background');
    assert.equal(store.job(notifiedJob.id).status, 'succeeded');
    assert.ok(await browser.evaluate<number>('window.__gravityAlertStats.sounds') > previewSounds, 'Completion also plays the enabled sound');
    assert.match(JSON.stringify(await browser.evaluate('window.__gravityAlertStats.notifications[0]')), new RegExp(notifiedJob.id), 'The alert identifies the completed job');
    await browser.until("!!document.querySelector('button[aria-label^=\"Dismiss \"]')", 'A completion also produces a dismissible in-app toast');
    await delay(450);
    for (const mobile of [false, true]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1440, height: mobile ? 844 : 960, deviceScaleFactor: 1, mobile });
      assert.equal(await browser.evaluate("(() => { const toast = document.querySelector('button[aria-label^=\"Dismiss \"]').closest('[role=status]'), rect = toast.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })()"), true, 'The completion toast stays within the viewport');
      await browser.screenshot(join(output, `notification-toast-${mobile ? 'mobile' : 'desktop'}.png`));
    }
    await browser.click('button[aria-label^="Dismiss "]');
    await browser.until("!document.querySelector('button[aria-label^=\"Dismiss \"]')", 'A toast can be dismissed without affecting the generated image');
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await browser.evaluate("window.__gravityBackground = false; document.dispatchEvent(new Event('visibilitychange'))");
    const completionSounds = await browser.evaluate<number>('window.__gravityAlertStats.sounds');
    await delay(6500);
    assert.equal(await browser.evaluate('window.__gravityAlertStats.notifications.length'), 1, 'Repeated state polls do not repeat an OS alert');
    assert.equal(await browser.evaluate('window.__gravityAlertStats.sounds'), completionSounds, 'Repeated state polls do not repeat the chime');
    await browser.send('Page.reload');
    await browser.until("document.querySelectorAll('main figure').length === 2 && !!navigator.serviceWorker.controller", 'Studio restores the completed job with the installed worker');
    await delay(3500);
    assert.equal(await browser.evaluate('window.__gravityAlertStats.notifications.length'), 1, 'Reloading in the background never replays completed jobs');
    assert.equal(await browser.evaluate('window.__gravityAlertStats.sounds'), completionSounds, 'Reloading does not replay sounds');
    assert.equal(await browser.evaluate('window.__gravityAlertStats.permissions'), 1, 'Saved preferences do not ask for permission again');
    await browser.click('header button[aria-label="Notifications"]');
    await browser.until(`document.querySelector(${JSON.stringify(soundSwitch)})?.getAttribute('aria-checked') === 'true' && document.querySelector(${JSON.stringify(desktopSwitch)})?.getAttribute('aria-checked') === 'true'`, 'Both notification preferences survive a page reload');
    await browser.evaluate("sessionStorage.setItem('browser-notification-permission', 'denied'); window.dispatchEvent(new Event('focus'))");
    await browser.until(`document.querySelector(${JSON.stringify(desktopSwitch)})?.disabled && document.querySelector(${JSON.stringify(notifications)})?.textContent.includes('Notifications are blocked for this site')`, 'Revoking browser permission gives an actionable explanation and disables its switch');
    assert.equal(await browser.evaluate('window.__gravityAlertStats.permissions'), 1, 'A blocked permission is never repeatedly requested');
    await browser.evaluate("sessionStorage.setItem('browser-notification-permission', 'granted'); window.dispatchEvent(new Event('focus'))");
    await browser.click('button[aria-label="Close notifications"]');

    await browser.evaluate("Promise.all([fetch('/api/state').then(response => response.json()), fetch('/api/bootstrap').then(response => response.json()), ...Array.from(document.querySelectorAll('main figure > img'), image => fetch(image.src).then(response => response.arrayBuffer()))]).then(() => true)");
    const cachedPaths = await browser.evaluate<string[]>("caches.keys().then(async names => (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat())");
    assert.ok(cachedPaths.includes('/offline.html'), 'The installed worker stores a public offline page');
    assert.ok(cachedPaths.every(path => path === '/offline.html' || path.startsWith('/pwa/') || path.startsWith('/_next/static/')), 'No prompts, authenticated pages, API responses or generated images enter the service-worker cache');
    await browser.send('Network.enable');
    await browser.send('Network.setCacheDisabled', { cacheDisabled: true });
    // CDP's page-only offline emulation leaves the service-worker network alive.
    // Stop the controlled frontend to make both targets experience a real outage.
    const frontendStopped = once(child, 'exit'); child.kill('SIGTERM'); await frontendStopped;
    try {
      await browser.navigate(`${origin}/image?offline-check=browser`);
      await browser.until("document.body.innerText.includes('Reconnect to your studio')", 'An offline navigation shows the generic recovery page');
      assert.equal(await browser.evaluate("document.body.innerText.includes('ceramic bowl') || !!document.querySelector('main figure')"), false, 'The offline page reveals no previous prompt or image');
      assert.equal(await browser.evaluate("fetch('/api/state').then(() => false, () => true)"), true, 'Authenticated API data is unavailable offline');
    } finally {
      child = startFrontend();
      for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Restarting. */ } if (child.exitCode !== null || attempt === 99) throw new Error(`Next could not restart: ${logs}`); await delay(100); }
    }
    await browser.send('Page.reload');
    await browser.until("!!document.querySelector('#image-prompt') && document.querySelectorAll('main figure').length === 2", 'Reconnecting restores the authenticated workspace');
  } finally {
    completeAutomatically = true;
    await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: alertMocks.identifier });
  }
  assert.deepEqual(browser.errors, []);
  t.diagnostic(`Screenshots: ${output}`);
});

test('file drops route to references or Assets without claiming text or navigating away from dialogs', { timeout: 120000 }, async t => {
  const fixture = await engineFixture({ count: 1 });
  const output = join(root, '.local/screenshots'); await mkdir(output, { recursive: true });
  const frontendPort = await freePort();
  const origin = `http://127.0.0.1:${frontendPort}`;
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, allowedOrigins: [origin], setupSecret: 'file-drop-fixture' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fixture.engine.start();
  let logs = '';
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  t.after(async () => {
    child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL');
    await server.closeOperations(); await close(server); await fixture.close();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ }
    if (child.exitCode !== null || attempt === 99) throw new Error(`File-drop frontend could not start: ${logs}`);
    await delay(100);
  }
  const browser = await openBrowser(t);
  const cookie = createSession(fixture.store, fixture.owner, false).split(';')[0];
  await browser.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' });
  await browser.navigate(`${origin}/image`);
  await browser.until("document.querySelector('button[aria-label=\"Model: SDXL Base 1.0\"]') && !document.querySelector('dialog[open]')", 'The authenticated file-drop workspace has its single-reference model');
  await browser.fill('#image-prompt', 'Keep this prompt while importing files.');
  await browser.evaluate(`(() => {
    window.__gravityFileDropFetch = window.fetch;
    window.__gravityFileDropUploads = { names: [], pending: 0 };
    window.fetch = async (input, options = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const upload = url.origin === location.origin && url.pathname === '/api/inputs' && String(options.method || 'GET').toUpperCase() === 'POST';
      if (upload) { window.__gravityFileDropUploads.names.push(decodeURIComponent(new Headers(options.headers).get('X-Filename') || '')); window.__gravityFileDropUploads.pending++; }
      try { if (upload && window.__gravityFileDropGate) await window.__gravityFileDropGate; return await window.__gravityFileDropFetch.call(window, input, options); }
      finally { if (upload) window.__gravityFileDropUploads.pending--; }
    };
  })()`);
  const bytes = Buffer.from(fixture.workers[0].state.outputBytes).toString('base64');
  type TransferFile = { name: string; type?: string; size?: number };
  async function transfer(type: 'dragenter' | 'dragleave' | 'dragover' | 'drop' | 'paste', target: string, files: TransferFile[] = [], text?: string) {
    return browser.evaluate<boolean>(`(() => {
      const target = ${target === 'document' ? 'document' : `document.querySelector(${JSON.stringify(target)})`};
      if (!target) throw new Error('Missing file-transfer target');
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), character => character.charCodeAt(0));
      for (const file of ${JSON.stringify(files)}) transfer.items.add(new File([file.size === undefined ? bytes : new Uint8Array(file.size)], file.name, {type: file.type || 'image/png'}));
      ${text === undefined ? '' : `transfer.setData('text/plain', ${JSON.stringify(text)});`}
      const event = ${type === 'paste' ? "new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true})" : `new DragEvent(${JSON.stringify(type)}, {dataTransfer: transfer, bubbles: true, cancelable: true})`};
      target.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
  }
  const png = (name: string): TransferFile[] => [{ name }];
  const references = "document.querySelectorAll('button[aria-label^=\"Remove reference \"]').length";
  const overlay = (target: 'references' | 'assets') => `document.querySelector('[data-file-drop-target="${target}"]')`;
  async function idle() { await browser.until('window.__gravityFileDropUploads.pending === 0', 'File requests settle'); await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'); }
  async function uploadCount() { return browser.evaluate<number>('window.__gravityFileDropUploads.names.length'); }
  async function removeReference() { await browser.click('button[aria-label="Remove reference 1"]'); await browser.until(`${references} === 0`, 'The reference slot is available again'); }

  assert.equal(await transfer('dragover', '#image-prompt', [], 'ordinary dragged text'), false, 'A text drag remains available to the textarea');
  assert.equal(await transfer('drop', '#image-prompt', [], 'ordinary dragged text'), false, 'A text drop is not claimed as a file upload');
  assert.equal(await transfer('paste', '#image-prompt', [], 'ordinary pasted text'), false, 'A text-only paste keeps its native textarea behavior');
  assert.equal(await uploadCount(), 0);
  assert.equal(await browser.evaluate(`!!${overlay('references')}`), false, 'Text transfers never show the file overlay');

  await transfer('dragenter', 'main', png('nested.png'));
  await browser.until(`!!${overlay('references')} && ${overlay('references')}.textContent.trim().length > 0`, 'Entering the gallery announces reference import');
  await browser.screenshot(join(output, 'file-drop-references-desktop.png'));
  await transfer('dragenter', '#image-prompt', png('nested.png'));
  await transfer('dragleave', '#image-prompt', png('nested.png'));
  await idle();
  assert.equal(await browser.evaluate(`!!${overlay('references')}`), true, 'Leaving a nested child keeps the parent drop overlay visible');
  await transfer('dragleave', 'main', png('nested.png'));
  await browser.until(`!${overlay('references')}`, 'Leaving the workspace clears the drop overlay');
  for (const [target, name] of [['main', 'gallery-drop.png'], ['header', 'header-drop.png'], ['document', 'document-drop.png'], ['#image-prompt', 'nested-prompt-drop.png']] as const) {
    const before = await uploadCount();
    assert.equal(await transfer('dragover', target, png(name)), true, 'File dragover permits a drop on the whole workspace');
    assert.equal(await transfer('drop', target, png(name)), true, 'File drops prevent browser navigation');
    await browser.until(`${references} === 1 && window.__gravityFileDropUploads.pending === 0`, `Dropping on ${target} attaches a reference`);
    assert.equal(await uploadCount(), before + 1, 'Bubbling through nested and document handlers uploads each file exactly once');
    assert.equal(fixture.store.inputs(fixture.owner.id).filter(input => input.name === name).length, 1);
    assert.equal(await browser.evaluate(`!!${overlay('references')}`), false, 'A completed drop clears its overlay');
    await removeReference();
  }
  const simultaneousBefore = await uploadCount();
  const prevented = await browser.evaluate<boolean[]>(`(() => {
    window.__gravityFileDropGate = new Promise(resolve => { window.__gravityReleaseFileDrop = resolve; });
    const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), character => character.charCodeAt(0));
    return ['simultaneous-first.png', 'simultaneous-second.png'].map(name => {
      const transfer = new DataTransfer(); transfer.items.add(new File([bytes], name, {type: 'image/png'}));
      const event = new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true});
      document.querySelector('#image-prompt').dispatchEvent(event);
      return event.defaultPrevented;
    });
  })()`);
  try {
    assert.deepEqual(prevented, [true, true]);
    assert.equal(await uploadCount(), simultaneousBefore + 1, 'Two synchronous drops share one in-flight reference upload');
    assert.equal(await browser.evaluate(references), 0, 'The concurrency check runs before the held upload can finish');
  } finally { await browser.evaluate('window.__gravityReleaseFileDrop(); delete window.__gravityFileDropGate; delete window.__gravityReleaseFileDrop'); }
  await browser.until(`${references} === 1 && window.__gravityFileDropUploads.pending === 0`, 'The first synchronous drop completes once');
  assert.equal(fixture.store.inputs(fixture.owner.id).filter(input => input.name === 'simultaneous-first.png').length, 1);
  assert.equal(fixture.store.inputs(fixture.owner.id).filter(input => input.name === 'simultaneous-second.png').length, 0, 'The second event cannot bypass the single-reference limit while React is updating');
  await removeReference();
  const invalidBefore = await uploadCount();
  for (const [files, message] of [
    [[{ name: 'unsupported.gif', type: 'image/gif' }], 'PNG, JPEG, or WebP'],
    [[{ name: 'too-large.png', size: 20 * 1024 ** 2 + 1 }], '20 MiB'],
    [[{ name: 'empty.png', size: 0 }], 'non-empty'],
    [[{ name: 'one.png' }, { name: 'two.png' }], '1 reference'],
  ] satisfies [TransferFile[], string][]) {
    assert.equal(await transfer('drop', 'main', files), true);
    await browser.until(`document.querySelector('main [role=alert]')?.textContent.includes(${JSON.stringify(message)})`, 'Unsupported, oversized or over-capacity files have actionable errors');
    await idle();
    assert.equal(await uploadCount(), invalidBefore, 'Rejected files never reach the upload API');
    assert.equal(await browser.evaluate(references), 0);
  }
  assert.equal(await transfer('paste', 'document', png('clipboard-reference.png')), true, 'File paste works outside the prompt field');
  await browser.until(`${references} === 1 && window.__gravityFileDropUploads.pending === 0`, 'Pasted files become references');
  const fullBefore = await uploadCount();
  await transfer('drop', 'header', png('over-capacity.png'));
  await browser.until("document.querySelector('main [role=alert]')?.textContent.includes('1 reference')", 'A full model reports its reference limit');
  assert.equal(await uploadCount(), fullBefore);
  assert.equal(await browser.evaluate(references), 1, 'A rejected drop preserves the existing reference');
  await removeReference();

  await browser.click('button[aria-label="Browse saved images"]');
  await browser.until("!!document.querySelector('#reference-picker-dialog[open] article[data-source=import]')", 'The picker loads existing imported files');
  const picked = '#reference-picker-dialog article[data-source=import] button[aria-pressed]:not([data-favorite-action])';
  await browser.click(picked);
  assert.equal(await transfer('drop', '#reference-picker-dialog input[aria-label="Search assets"]', [{ name: 'picker-invalid.gif', type: 'image/gif' }]), true);
  await browser.until("!!document.querySelector('#reference-picker-dialog[open] [role=alert]')", 'Invalid direct picker drops stay in the picker');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(picked)}).getAttribute('aria-pressed')`), 'true', 'A rejected picker drop preserves its unfinished selection');
  await transfer('dragenter', '#reference-picker-dialog', png('picker-drop.png'));
  await browser.until(`!!document.querySelector('#reference-picker-dialog [data-file-drop-target="references"]')`, 'The active picker owns the reference drop overlay');
  assert.equal(await transfer('drop', '#reference-picker-dialog input[aria-label="Search assets"]', png('picker-drop.png')), true);
  await browser.until(`!document.querySelector('#reference-picker-dialog[open]') && ${references} === 1 && window.__gravityFileDropUploads.pending === 0`, 'Successful picker drops attach a reference and close the picker');
  assert.equal(fixture.store.inputs(fixture.owner.id).filter(input => input.name === 'picker-drop.png').length, 1, 'The modal and workspace do not duplicate a picker upload');
  await removeReference();

  await browser.click('header button[aria-label="Assets"]');
  await browser.until("!!document.querySelector('#assets-browser-dialog[open] article[data-source=import]')", 'Assets opens for library imports');
  await transfer('dragenter', '#assets-browser-dialog input[aria-label="Search assets"]', png('library-drop.png'));
  await browser.until(`!!document.querySelector('#assets-browser-dialog [data-file-drop-target="assets"]')`, 'Assets identifies library imports in its drop overlay');
  await browser.screenshot(join(output, 'file-drop-assets-desktop.png'));
  assert.equal(await browser.evaluate(`!!${overlay('references')}`), false, 'An active library modal suppresses the workspace reference overlay');
  const libraryBefore = await uploadCount();
  assert.equal(await transfer('drop', '#assets-browser-dialog input[aria-label="Search assets"]', png('library-drop.png')), true);
  await browser.until("!!document.querySelector('#assets-browser-dialog[open] button[aria-label=\"Open library-drop.png\"]') && window.__gravityFileDropUploads.pending === 0", 'Nested Assets drops save to the library and leave it open');
  assert.equal(await uploadCount(), libraryBefore + 1);
  assert.equal(await browser.evaluate(references), 0, 'Library imports do not select a composer reference');
  assert.equal(await transfer('paste', '#assets-browser-dialog input[aria-label="Search assets"]', png('library-paste.png')), true);
  await browser.until("!!document.querySelector('#assets-browser-dialog[open] button[aria-label=\"Open library-paste.png\"]') && window.__gravityFileDropUploads.pending === 0", 'File paste in Assets stays a library operation');
  const batchBefore = await uploadCount();
  assert.equal(await transfer('drop', '#assets-browser-dialog [aria-label="Asset gallery"]', [{ name: 'library-batch-one.png' }, { name: 'library-batch-two.png' }]), true);
  await browser.until("document.querySelector('#assets-browser-dialog[open] button[aria-label=\"Open library-batch-one.png\"]') && document.querySelector('#assets-browser-dialog[open] button[aria-label=\"Open library-batch-two.png\"]') && window.__gravityFileDropUploads.pending === 0", 'A multi-file Assets drop imports the entire batch');
  assert.equal(await uploadCount(), batchBefore + 2, 'Each file in an Assets batch uploads exactly once');
  assert.equal(await browser.evaluate(references), 0, 'The library batch is independent of the selected model reference limit');
  const outsideBefore = await uploadCount();
  await transfer('drop', 'document', png('library-document-drop.png'));
  await browser.until("!!document.querySelector('#assets-browser-dialog[open] button[aria-label=\"Open library-document-drop.png\"]') && window.__gravityFileDropUploads.pending === 0", 'The active modal routes document-level file drops to Assets');
  assert.equal(await uploadCount(), outsideBefore + 1);
  assert.equal(await browser.evaluate(references), 0);
  const previewBefore = await uploadCount();
  await browser.click('#assets-browser-dialog button[aria-label="Open library-drop.png"]');
  await browser.until("!!document.querySelector('#assets-input-viewer[open]')", 'An imported-image viewer is the active dialog');
  assert.equal(await transfer('dragover', '#assets-input-viewer', png('blocked-viewer.png')), true);
  assert.equal(await transfer('drop', '#assets-input-viewer', png('blocked-viewer.png')), true);
  await idle();
  assert.equal(await uploadCount(), previewBefore, 'An image viewer blocks navigation without uploading into the underlying Assets modal');
  assert.equal(await browser.evaluate('location.pathname'), '/image');
  await browser.click('#assets-input-viewer button[aria-label="Close preview"]');
  await browser.key('Escape');
  await browser.until("!document.querySelector('dialog[open]')", 'Assets closes before other modal routing checks');
  for (const panel of ['Settings', 'Models']) {
    await browser.click(`header button[aria-label="${panel}"]`);
    await browser.until(`!!document.querySelector('#${panel.toLowerCase()}-dialog[open]')`, `${panel} is the active modal`);
    const before = await uploadCount();
    assert.equal(await transfer('dragover', 'document', png(`blocked-${panel}.png`)), true);
    assert.equal(await transfer('drop', 'document', png(`blocked-${panel}.png`)), true);
    await idle();
    assert.equal(await uploadCount(), before, 'Unrelated dialogs block file navigation without attaching or importing files');
    assert.equal(await browser.evaluate(`!!${overlay('references')} || !!${overlay('assets')}`), false, 'Unrelated dialogs show no import overlay');
    assert.equal(await browser.evaluate('location.pathname'), '/image');
    await browser.click(`button[aria-label="Close ${panel.toLowerCase()}"]`);
  }
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), 'Keep this prompt while importing files.');
  assert.equal(fixture.store.jobs(fixture.owner.id).length, 0, 'Import checks never submit generation jobs');
  assert.deepEqual(browser.errors, []);
});

test('Upscale queues independent results from outputs and imports with model and size recovery', { timeout: 120000 }, async t => {
  const fixture = await engineFixture({ count: 1 });
  const output = join(root, '.local/screenshots'); await mkdir(output, { recursive: true });
  const frontendPort = await freePort(), origin = `http://127.0.0.1:${frontendPort}`;
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, allowedOrigins: [origin], setupSecret: 'upscale-browser-fixture' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fixture.engine.start();
  let logs = '';
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  t.after(async () => { child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL'); await server.closeOperations(); await close(server); await fixture.close(); });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ }
    if (child.exitCode !== null || attempt === 99) throw new Error(`Upscale frontend could not start: ${logs}`);
    await delay(100);
  }
  const browser = await openBrowser(t);
  const cookie = createSession(fixture.store, fixture.owner, false).split(';')[0];
  await browser.send('Network.enable');
  await browser.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' });
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const sharp = require('sharp') as (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };
  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="64" y="64" width="384" height="384" rx="32" fill="#d1fe17"/></svg>')).png().toBuffer();
  const imageUrl = `data:image/png;base64,${png.toString('base64')}`;
  // Images and upscale responses are synthetic. No model download, upload or
  // generation request reaches the server; this isolates the UI contract.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__upscaleInstalled = false; window.__upscaleRequests = []; window.__upscaleEvents = []; window.__upscaleFailOnce = true;
    window.__upscaleOriginal = {id:'upscale-original-job',modelId:'wai-illustrious-v17',modelName:'Original generation',prompt:'Keep this original image',input:{modelId:'wai-illustrious-v17',prompt:'Keep this original image'},parameters:{width:512,height:512,steps:20,cfg:5,seed:7},status:'succeeded',stage:'Complete',progress:1,createdAt:'2026-01-01T12:00:00.000Z',outputs:[{id:'upscale-original-output',url:${JSON.stringify(imageUrl)},width:512,height:512,mimeType:'image/png'}],error:null};
    window.__upscaleJobs = [window.__upscaleOriginal];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href), method = String(options.method || 'GET').toUpperCase();
      if (url.origin !== location.origin) return originalFetch(input, options);
      if (url.pathname === '/api/upscalers') return Response.json({models:[{id:'fixture-upscaler',name:'Fixture Upscaler',description:'Enlarge image details without changing the source.',scales:[2,4],maxOutputDimension:4096,installed:window.__upscaleInstalled,ready:window.__upscaleInstalled,missingReasons:[]},{id:'fixture-offline-upscaler',name:'Offline Upscaler',description:'A downloaded model on a disconnected worker.',scales:[2,4],maxOutputDimension:4096,installed:window.__upscaleInstalled,ready:false,missingReasons:['Connect the worker that provides this upscaler.']}]});
      if (url.pathname === '/api/inputs' && method === 'GET') return Response.json({inputs:[{id:'upscale-import',name:'Large imported image.png',url:${JSON.stringify(imageUrl)},width:1536,height:1024}]});
      if (url.pathname === '/api/upscale' && method === 'POST') {
        const body = JSON.parse(options.body); window.__upscaleRequests.push({body,key:new Headers(options.headers).get('Idempotency-Key')});
        if (window.__upscaleFailOnce) { window.__upscaleFailOnce = false; return Response.json({error:'Worker temporarily unavailable. Try again.'},{status:503}); }
        const imported = body.source.type === 'input', width = imported ? 1536 : 512, height = imported ? 1024 : 512;
        const job = {id:'upscale-result-' + window.__upscaleJobs.length,modelId:body.modelId,modelName:'Fixture Upscaler',prompt:'Upscale ' + body.scale + '×',input:body,parameters:{width:width*body.scale,height:height*body.scale,scale:body.scale,sourceWidth:width,sourceHeight:height},status:'queued',stage:'Waiting in queue',progress:null,createdAt:new Date().toISOString(),outputs:[],error:null};
        window.__upscaleJobs.unshift(job); return Response.json({job});
      }
      if (url.pathname === '/api/models/access' && method === 'POST') { window.__upscaleEvents.push(url.pathname); return Response.json({available:true,hasToken:false,checkedAt:new Date().toISOString(),repositories:[]}); }
      if (url.pathname === '/api/models/download' && method === 'POST') { window.__upscaleEvents.push(url.pathname); window.__upscaleInstalled = true; return Response.json({id:'upscale-model-download',modelId:'fixture-upscaler',modelName:'Fixture Upscaler',status:'succeeded',stage:'Downloaded',completedFiles:1,totalFiles:1,receivedBytes:32,totalBytes:32,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}); }
      const response = await originalFetch(input, options);
      if (method !== 'GET' || !response.ok) return response;
      if (url.pathname === '/api/state') return Response.json({...await response.json(),jobs:window.__upscaleJobs});
      if (url.pathname === '/api/models/library') return Response.json({...await response.json(),models:[{id:'fixture-upscaler',name:'Fixture Upscaler',familyId:'upscale',family:'Upscale',kind:'utility',category:'upscale',description:'Enlarge image details without changing the source.',repositories:[],source:'catalog',installed:window.__upscaleInstalled,enabled:window.__upscaleInstalled,downloadable:true,artifacts:[]}]});
      return response;
    };
  ` });
  const popover = '[popover]:popover-open[aria-label="Upscale image"]';
  async function openUpscale(viewer = '#output-viewer') {
    await browser.click(`${viewer} button[aria-label="Upscale image"]`);
    await browser.until(`document.querySelector(${JSON.stringify(popover)}) && getComputedStyle(document.querySelector(${JSON.stringify(popover)})).visibility === 'visible' && !document.querySelector(${JSON.stringify(`${popover} [role=status]`)})`, 'Upscale options finish loading');
    await browser.evaluate(`Promise.all(document.querySelector(${JSON.stringify(popover)}).getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)`);
  }
  const scaleButton = (value: number) => `${popover} [aria-label="Upscale size"] button:nth-child(${value === 2 ? 1 : 2})`;
  const submit = `${popover} button.bg-volt`;
  async function capture(surface: string) {
    for (const width of [1440, 390, 320]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 960 : 844, deviceScaleFactor: 1, mobile: width < 768 });
      await browser.evaluate(`Promise.all([document.fonts.ready,...document.querySelector(${JSON.stringify(popover)}).getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`);
      assert.equal(await browser.evaluate(`(() => {const panel=document.querySelector(${JSON.stringify(popover)}),rect=panel.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth+1 && rect.top>=0 && rect.bottom<=innerHeight+1 && panel.scrollWidth<=panel.clientWidth+1 && document.documentElement.scrollWidth<=innerWidth;})()`), true, `${surface} fits ${width}px`);
      await browser.screenshot(join(output, `upscale-${surface}-${width}.png`));
    }
  }
  await browser.navigate(`${origin}/image`);
  await browser.until("!!document.querySelector('main figure button[aria-label=\"Open Original generation output\"]')", 'The original generated output is available');
  await browser.fill('#image-prompt', 'Keep this draft unchanged');
  await browser.click('main figure button[aria-label="Open Original generation output"]');
  await openUpscale();
  assert.match(await browser.evaluate<string>(`document.querySelector(${JSON.stringify(popover)}).textContent`), /Download an upscaler/);
  await browser.click(`${popover} [data-upscale-manage]`);
  await browser.until("document.querySelector('#models-dialog[open]') && document.querySelector('#models-tab-tools')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#models-panel-tools article')", 'Empty state opens Models directly in Tools');
  assert.equal(await browser.evaluate("document.querySelectorAll('#models-panel-library article[data-model-id=fixture-upscaler]').length"), 0, 'Upscalers stay outside the generation library');
  await browser.click('#models-panel-tools article button');
  await browser.until("document.querySelector('#models-tab-downloads')?.getAttribute('aria-selected') === 'true'", 'Tool downloads use the existing download flow');
  assert.deepEqual(await browser.evaluate('window.__upscaleEvents'), ['/api/models/access', '/api/models/download'], 'A tool download still checks repository access first');
  await browser.click('#models-tab-tools');
  await browser.until("document.querySelector('#models-panel-tools article')?.textContent.includes('Downloaded')", 'A downloaded tool needs no generation activation');
  await browser.click('button[aria-label="Close models"]');
  await browser.click('main figure button[aria-label="Open Original generation output"]');
  await openUpscale();
  await browser.fill(`${popover} select`, 'fixture-offline-upscaler');
  await browser.until(`document.querySelector(${JSON.stringify(popover)}).textContent.includes('Connect the worker')`, 'Downloaded but unavailable models explain worker recovery');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(submit)}).disabled`), true);
  await browser.fill(`${popover} select`, 'fixture-upscaler');
  await browser.click(scaleButton(4));
  assert.match(await browser.evaluate<string>(`document.querySelector(${JSON.stringify(popover)}).textContent`), /512 × 512 → 2048 × 2048/);
  await capture('output');
  await browser.click(submit);
  await browser.until(`document.querySelector(${JSON.stringify(`${popover} [role=alert]`)})?.textContent.includes('temporarily unavailable')`, 'A failed submission retains its choices for retry');
  await browser.click(submit);
  await browser.until("!document.querySelector('#output-viewer[open]') && document.querySelector('main').textContent.includes('Waiting in queue')", 'Successful upscale closes the preview and enters the existing queue');
  assert.deepEqual(await browser.evaluate('window.__upscaleRequests.map(request=>request.body)'), [1, 2].map(() => ({ operation: 'upscale', modelId: 'fixture-upscaler', source: { type: 'output', jobId: 'upscale-original-job', outputId: 'upscale-original-output' }, scale: 4 })), 'Generated output references its stored source without upload');
  assert.equal(await browser.evaluate('window.__upscaleRequests[0].key === window.__upscaleRequests[1].key && !!window.__upscaleRequests[0].key'), true, 'Retry keeps its idempotency key');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), 'Keep this draft unchanged');
  assert.equal(await browser.evaluate('window.__upscaleOriginal.outputs.length'), 1, 'The original image remains saved');
  await browser.evaluate(`Object.assign(window.__upscaleJobs[0],{status:'succeeded',stage:'Complete',progress:1,outputs:[{id:'upscale-finished-output',url:${JSON.stringify(imageUrl)},width:2048,height:2048,mimeType:'image/png'}]})`);
  await browser.until("!!document.querySelector('main figure button[aria-label=\"Open Fixture Upscaler output\"]')", 'Completed upscales become normal gallery assets');
  assert.equal(await browser.evaluate("document.querySelector('main figure button[aria-label=\"Open Fixture Upscaler output\"]').closest('figure').querySelector('[aria-label=\"Use these settings\"]') === null"), true, 'Upscale tiles cannot load generation settings');
  await browser.click('main figure button[aria-label="Open Fixture Upscaler output"]');
  await browser.until("!!document.querySelector('#output-viewer[open]')", 'The upscaled image opens');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#output-viewer button')).some(button=>button.textContent.includes('Use these settings'))"), false);
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#output-viewer dt')).some(label=>label.textContent==='Scale') && !Array.from(document.querySelectorAll('#output-viewer dt')).some(label=>['Steps','Guidance','Seed'].includes(label.textContent))"), true, 'Upscale details show scaling instead of generation parameters');
  await browser.click('#output-viewer button[aria-label="Close preview"]');
  await browser.click('header button[aria-label="Assets"]');
  await browser.until("!!document.querySelector('#assets-browser-dialog article[data-asset-id=upscale-import]')", 'Imported sources remain available');
  await browser.click('#assets-browser-dialog article[data-asset-id=upscale-import] > button');
  await openUpscale('#assets-input-viewer');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(scaleButton(4))}).disabled`), true, 'The oversized 4× output is blocked before submitting');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(scaleButton(2))}).disabled`), false, 'A safe 2× output remains available');
  await capture('import-limit');
  await browser.click(submit);
  await browser.until("!document.querySelector('#assets-input-viewer[open]') && !document.querySelector('#assets-browser-dialog[open]')", 'Submitting an imported image returns to the queue workspace');
  assert.deepEqual(await browser.evaluate('window.__upscaleRequests.at(-1).body'), { operation: 'upscale', modelId: 'fixture-upscaler', source: { type: 'input', inputId: 'upscale-import' }, scale: 2 }, 'Imported images keep their original input reference');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), 'Keep this draft unchanged');
  assert.equal(await browser.evaluate('window.__upscaleJobs.length'), 3, 'Each upscale creates a separate result');
  assert.equal(fixture.store.jobs(fixture.owner.id).length, 0); assert.equal(fixture.workers[0].state.submissions.length, 0);
  assert.deepEqual(browser.errors, []);
});

test('model downloads check Hugging Face access and guide gated, token and license recovery', { timeout: 120000 }, async t => {
  const fixture = await engineFixture({ count: 1 });
  const output = join(root, '.local/screenshots'); await mkdir(output, { recursive: true });
  const frontendPort = await freePort();
  const origin = `http://127.0.0.1:${frontendPort}`;
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, allowedOrigins: [origin], setupSecret: 'model-access-browser-fixture' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fixture.engine.start();
  let logs = '';
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  t.after(async () => {
    child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL');
    await server.closeOperations(); await close(server); await fixture.close();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ }
    if (child.exitCode !== null || attempt === 99) throw new Error(`Model access frontend could not start: ${logs}`);
    await delay(100);
  }
  const browser = await openBrowser(t);
  const cookie = createSession(fixture.store, fixture.owner, false).split(';')[0];
  await browser.send('Network.enable');
  await browser.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' });
  // Provider credential writes use the real encrypted endpoint. Only repository
  // access and download responses are fixtures; no license is accepted or weight fetched.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__hfAccessStatus = 'gated'; window.__hfEvents = []; window.__hfDownload = null; window.__hfDownloadFailure = false;
    const originalFetch = window.fetch.bind(window);
    const messages = {available:'Repository access confirmed.',gated:'Accept this repository’s terms or request access on Hugging Face, then save a read token from the same account.',unauthorized:'Your Hugging Face token was not accepted. Save a valid read token and check again.',forbidden:'Your token cannot read this repository. Check its permissions.'};
    window.fetch = async (input, options = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin === location.origin && method === 'POST' && ['/api/models/access','/api/models/download'].includes(url.pathname)) {
        const body = JSON.parse(options.body), id = body.url ? new URL(body.url).pathname.split('/').slice(1,3).join('/') : 'Comfy-Org/Ideogram-4';
        const repository = {id,url:'https://huggingface.co/' + id};
        window.__hfEvents.push({path:url.pathname,body});
        if (url.pathname === '/api/models/access') {
          const providers = await originalFetch('/api/integrations').then(response => response.json());
          const status = window.__hfAccessStatus;
          return Response.json({...(body.modelId ? {modelId:body.modelId} : {}),available:status === 'available',hasToken:!!providers.providers.find(provider => provider.id === 'huggingface').credential,checkedAt:new Date().toISOString(),repositories:[{...repository,status,message:messages[status]}]});
        }
        window.__hfDownload = {id:'access-download-fixture',modelId:body.modelId || 'import-access-fixture',modelName:body.name || 'Ideogram 4 FP8',status:window.__hfDownloadFailure ? 'failed' : 'succeeded',stage:window.__hfDownloadFailure ? 'Download failed' : 'Ready to use',completedFiles:1,totalFiles:1,receivedBytes:32,totalBytes:32,startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),...(window.__hfDownloadFailure ? {error:'Repository access changed during the download.',errorCode:'MODEL_ACCESS_FORBIDDEN',access:{repository,status:'forbidden',message:messages.forbidden}} : {})};
        return Response.json(window.__hfDownload);
      }
      const response = await originalFetch(input, options);
      if (url.origin === location.origin && url.pathname === '/api/models/library' && method === 'GET' && response.ok) {
        const library = await response.json();
        return Response.json({...library,models:library.models.filter(model => ['ideogram-4-fp8','qwen-image-2.1','krea-2-turbo'].includes(model.id)).map(model => ({...model,installed:false,enabled:false})),download:window.__hfDownload});
      }
      return response;
    };
  ` });
  const article = '#models-panel-library article[data-model-id="ideogram-4-fp8"]';
  const check = `${article} > div:last-child > button:last-of-type`;
  const download = `${article} > div:last-child > button:first-of-type`;
  const tokenForm = '#models-panel-huggingface form[aria-labelledby="models-integration-huggingface-title"]';
  const tokenInput = `${tokenForm} input[type=password]`;
  const importForm = '#models-panel-huggingface form:not([aria-labelledby])';
  const importedUrl = 'https://huggingface.co/private/import/blob/main/checkpoint.safetensors';
  const downloadCount = () => browser.evaluate<number>("window.__hfEvents.filter(event => event.path === '/api/models/download').length");
  async function modelReady() { await browser.until(`!!document.querySelector(${JSON.stringify(check)}) && !document.querySelector(${JSON.stringify(check)}).disabled`, 'Model access actions are ready'); }
  async function captures(surface: string) {
    for (const width of [1440, 390]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 960 : 844, deviceScaleFactor: 1, mobile: width < 768 });
      await browser.evaluate("document.querySelector('#models-dialog [data-dialog-scroll]').scrollTop = 0");
      if (surface === 'library-gated') await browser.evaluate(`document.querySelector(${JSON.stringify(`${article} [role=alert]`)}).scrollIntoView({block:'center'})`);
      await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('#models-dialog').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))");
      assert.equal(await browser.evaluate("(() => { const dialog = document.querySelector('#models-dialog'), rect = dialog.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()"), true, `${surface} fits ${width}px`);
      await browser.screenshot(join(output, `model-access-${surface}-${width}.png`));
    }
  }
  await browser.navigate(`${origin}/image`);
  await browser.until("!!document.querySelector('header button[aria-label=\"Models\"]')", 'The workspace loads');
  await browser.click('header button[aria-label="Models"]'); await modelReady();
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${article} a[href="https://huggingface.co/Comfy-Org/Ideogram-4"]`)})?.target`), '_blank', 'The download repository is linked directly');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${article} a[href="https://huggingface.co/ideogram-ai/ideogram-4-fp8/blob/main/LICENSE.md"]`)})?.textContent`), 'License', 'Ideogram links its publisher license separately from the artifact repository');
  await browser.click(check);
  await browser.until(`document.querySelector(${JSON.stringify(`${article} [role=alert]`)})?.textContent.includes('request access')`, 'Gated access explains the external approval step');
  assert.equal(await downloadCount(), 0, 'Check access never starts a download');
  await browser.click(download); await modelReady();
  assert.equal(await downloadCount(), 0, 'Download preflight blocks weights while access is gated');
  await captures('library-gated');
  await browser.click(`${article} [role=alert] button`);
  await browser.until(`document.querySelector('#models-tab-huggingface')?.getAttribute('aria-selected') === 'true' && !!document.querySelector(${JSON.stringify(tokenInput)})`, 'Recovery opens the shared Hugging Face token form');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(tokenInput)}).value`), '', 'A saved token is never populated into the password input');
  await captures('huggingface');
  const token = 'hf_browser_read_token_ab12';
  await browser.fill(tokenInput, token); await browser.click(`${tokenForm} button[type=submit]`);
  await browser.until(`document.querySelector(${JSON.stringify(tokenForm)})?.textContent.includes('•••• ab12') && document.querySelector(${JSON.stringify(tokenInput)}).value === ''`, 'The real encrypted endpoint saves the token and clears the secret');
  const stored = fixture.store.db.prepare("SELECT ciphertext,suffix FROM integration_credentials WHERE provider='huggingface'").get() as { ciphertext: string; suffix: string };
  assert.equal(stored.suffix, 'ab12'); assert.equal(String(stored.ciphertext).includes(token), false, 'The credential is encrypted at rest');
  assert.equal(await browser.evaluate(`JSON.stringify({...localStorage,...sessionStorage}).includes(${JSON.stringify(token)})`), false, 'The token is absent from browser storage');
  await browser.click('#models-panel-huggingface > button'); await modelReady();
  assert.equal(await browser.evaluate(`!!document.querySelector(${JSON.stringify(`${article} [role=alert], ${article} [role=status]`)})`), false, 'Saving a token invalidates earlier repository checks');
  await browser.click(check); await modelReady();
  assert.equal(await downloadCount(), 0, 'Saving a token does not accept a model license or start a download');
  assert.match(await browser.evaluate<string>(`document.querySelector(${JSON.stringify(`${article} [role=alert]`)}).textContent`), /Accept this repository/);
  await browser.evaluate("window.__hfAccessStatus = 'available'");
  await browser.click(check);
  await browser.until(`document.querySelector(${JSON.stringify(`${article} [role=status]`)})?.textContent.includes('Access confirmed')`, 'Checking again recognizes manually granted access');

  await browser.click('button[aria-label="Close models"]');
  await browser.click('header button[aria-label="Settings"]');
  await browser.click('#settings-tab-integrations');
  const settingsTokenForm = '#settings-panel-integrations form[aria-labelledby="integration-huggingface-title"]';
  await browser.until(`!!document.querySelector(${JSON.stringify(`${settingsTokenForm} input[type=password]`)})`, 'The same credential can be updated from Settings');
  await browser.fill(`${settingsTokenForm} input[type=password]`, 'hf_browser_replacement_cd34');
  await browser.click(`${settingsTokenForm} button[type=submit]`);
  await browser.until(`document.querySelector(${JSON.stringify(settingsTokenForm)})?.textContent.includes('•••• cd34')`, 'Settings saves a replacement credential');
  await browser.click('button[aria-label="Close settings"]');
  await browser.click('header button[aria-label="Models"]'); await modelReady();
  await browser.until(`!document.querySelector(${JSON.stringify(`${article} [role=status]`)})`, 'Reopening Models invalidates access checked with the older credential');
  await browser.click(download);
  await browser.until("document.querySelector('#models-tab-downloads')?.getAttribute('aria-selected') === 'true'", 'Successful preflight opens the download status');
  assert.equal(await downloadCount(), 1);
  assert.deepEqual(await browser.evaluate("window.__hfEvents.slice(-2).map(event => ({path:event.path,body:event.body}))"), [{ path: '/api/models/access', body: { modelId: 'ideogram-4-fp8' } }, { path: '/api/models/download', body: { modelId: 'ideogram-4-fp8' } }], 'Every Download rechecks the exact model immediately before starting');

  await browser.click('#models-tab-huggingface');
  await browser.fill(`${importForm} input[name=checkpoint-url]`, importedUrl);
  await browser.fill(`${importForm} input[name=checkpoint-name]`, 'Private checkpoint');
  for (const [status, message] of [['unauthorized', 'token was not accepted'], ['forbidden', 'Check its permissions']] as const) {
    await browser.evaluate(`window.__hfAccessStatus = ${JSON.stringify(status)}`);
    await browser.click(`${importForm} button:not([type])`);
    await browser.until(`document.querySelector('#models-panel-huggingface [role=alert]')?.textContent.includes(${JSON.stringify(message)})`, `${status} access has distinct recovery guidance`);
    assert.equal(await downloadCount(), 1, 'An imported checkpoint is also gated by a fresh access check');
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${importForm} input[name=checkpoint-url]`)}).value`), importedUrl, 'A failed access check retains the import draft');
    assert.equal(await browser.evaluate("document.querySelector('#models-panel-huggingface [role=alert] a').href"), 'https://huggingface.co/private/import', 'Recovery links the exact imported repository');
    assert.equal(await browser.evaluate("document.querySelector('#models-panel-huggingface [role=alert]').textContent.includes('Review terms')"), false, 'Plain token failures do not claim a gated license response');
  }
  await browser.evaluate("window.__hfAccessStatus = 'available'; window.__hfDownloadFailure = true");
  await browser.click(`${importForm} button:not([type])`);
  await browser.until("document.querySelector('#models-panel-downloads [role=alert]')?.textContent.includes('Check its permissions')", 'A late download access failure retains actionable recovery');
  assert.equal(await downloadCount(), 2);
  assert.deepEqual(await browser.evaluate("window.__hfEvents.slice(-2).map(event => event.body)"), [{ url: importedUrl }, { url: importedUrl, name: 'Private checkpoint', familyId: 'sdxl' }], 'Import preflight uses the exact file URL before starting its download');
  assert.equal(await browser.evaluate("document.querySelector('#models-panel-downloads [role=alert] a').href"), 'https://huggingface.co/private/import');
  await browser.click('#models-panel-downloads [role=alert] button');
  await browser.until(`!!document.querySelector(${JSON.stringify(tokenInput)}) && document.querySelector('#models-tab-huggingface')?.getAttribute('aria-selected') === 'true'`, 'A failed download can reopen token settings');
  await browser.click(`${tokenForm} button[aria-label="Remove Hugging Face key"]`);
  await browser.until(`document.querySelector(${JSON.stringify(tokenForm)})?.textContent.includes('No key saved')`, 'Removing the token clears its status');
  await browser.click('#models-tab-library');
  assert.equal(await browser.evaluate(`!!document.querySelector(${JSON.stringify(`${article} [role=status]`)})`), false, 'Removing a token invalidates checks');
  assert.equal(fixture.store.jobs(fixture.owner.id).length, 0);
  assert.equal(fixture.workers[0].state.submissions.length, 0);
  assert.deepEqual(browser.errors, []);
});

test('Background preserves draft intent, submits each mode and reuses transparency across model capabilities', { timeout: 120000 }, async t => {
  const fixture = await engineFixture({ count: 1 });
  const output = join(root, '.local/screenshots'); await mkdir(output, { recursive: true });
  const frontendPort = await freePort();
  const origin = `http://127.0.0.1:${frontendPort}`;
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, allowedOrigins: [origin], setupSecret: 'background-browser-fixture' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fixture.engine.start();
  let logs = '';
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  t.after(async () => {
    child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL');
    await server.closeOperations(); await close(server); await fixture.close();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ }
    if (child.exitCode !== null || attempt === 99) throw new Error(`Background frontend could not start: ${logs}`);
    await delay(100);
  }
  const browser = await openBrowser(t);
  const cookie = createSession(fixture.store, fixture.owner, false).split(';')[0];
  await browser.send('Network.enable');
  await browser.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' });
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const sharp = require('sharp') as (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };
  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><circle cx="256" cy="256" r="144" fill="#d1fe17"/></svg>')).png().toBuffer();
  const imageUrl = `data:image/png;base64,${png.toString('base64')}`;
  const unavailable = 'Install BiRefNet from Models to use transparent backgrounds.';
  // This fixture isolates composer behavior: model readiness and generated alpha
  // output are synthetic, and POST /jobs never reaches the server or ComfyUI.
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__backgroundRequests = JSON.parse(sessionStorage.getItem('background-fixture-requests') || '[]');
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = String(options.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.origin === location.origin && url.pathname === '/api/jobs' && method === 'POST') {
        const body = JSON.parse(options.body);
        window.__backgroundRequests.push(body);
        sessionStorage.setItem('background-fixture-requests', JSON.stringify(window.__backgroundRequests));
        const job = {id:'background-fixture-result', modelId:body.modelId, prompt:body.prompt, parameters:{width:body.width,height:body.height,steps:body.steps,cfg:body.cfg,seed:body.seed ?? 42,negativePrompt:body.negativePrompt,background:body.background},status:'succeeded',stage:'Complete',progress:1,createdAt:'2026-01-01T12:00:00.000Z',updatedAt:'2026-01-01T12:00:00.000Z',outputs:[{id:'background-output',url:${JSON.stringify(imageUrl)},width:512,height:512,mimeType:'image/png'}],error:null};
        sessionStorage.setItem('background-fixture-job', JSON.stringify(job));
        return Response.json(job);
      }
      const response = await originalFetch(input, options);
      if (url.origin !== location.origin || method !== 'GET' || !response.ok) return response;
      if (url.pathname === '/api/catalog') {
        const catalog = await response.json();
        catalog.models = catalog.models.filter(model => ['qwen-image-2.1','flux-2-klein-4b','wai-illustrious-v17'].includes(model.id)).map(model => ({...model,installed:true,ready:true,unavailableReason:'',missingReasons:[],capabilities:{...model.capabilities,background:{native:model.id === 'qwen-image-2.1',available:model.id !== 'wai-illustrious-v17',...(model.id === 'wai-illustrious-v17' ? {reason:${JSON.stringify(unavailable)}} : {})}}}));
        return Response.json(catalog);
      }
      if (url.pathname === '/api/state') {
        const state = await response.json(), job = JSON.parse(sessionStorage.getItem('background-fixture-job') || 'null');
        return Response.json({...state,jobs:job ? [job] : []});
      }
      return response;
    };
  ` });
  const background = 'button[aria-label^="Background:"]';
  const generate = 'button[title^="Submit to your generation queue"]';
  const reset = 'button[aria-label="Reset settings to defaults"]';
  const draftKey = `gravity:image-draft:${fixture.owner.id}`;
  async function selectModel(name: string) {
    await browser.click('button[aria-label^="Model:"]');
    const row = `Array.from(document.querySelectorAll('[popover]:popover-open [role=menuitem]')).find(row => row.textContent.includes(${JSON.stringify(name)}))`;
    await browser.until(`!!(${row}) && !(${row}).disabled && getComputedStyle(${row}).visibility === 'visible'`, `${name} is available`);
    await browser.evaluate("Promise.all(document.querySelector('[popover]:popover-open').getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)");
    await browser.clickText(await browser.evaluate<string>(`(${row}).textContent.trim()`));
    await browser.until(`!!document.querySelector('button[aria-label=${JSON.stringify(`Model: ${name}`)}]') && !document.querySelector('[popover]:popover-open')`, `${name} selected`);
  }
  async function selectBackground(label: string) {
    await browser.click(background);
    await browser.click(`[popover]:popover-open [aria-label="Background ${label}"]`);
    await browser.until(`!!document.querySelector('button[aria-label=${JSON.stringify(`Background: ${label}`)}]') && !document.querySelector('[popover]:popover-open')`, `Background ${label} selected`);
  }
  async function submit(expectedCount: number, mode: string, modelId: string) {
    await browser.until(`!document.querySelector(${JSON.stringify(generate)}).disabled`, 'The selected background can be submitted');
    await browser.click(generate);
    await browser.until(`window.__backgroundRequests.length === ${expectedCount} && !document.querySelector(${JSON.stringify(background)}).disabled`, 'The request is captured and composer is ready again');
    assert.deepEqual(await browser.evaluate('(() => { const body = window.__backgroundRequests.at(-1); return {background:body.background,modelId:body.modelId}; })()'), { background: mode, modelId }, 'The job payload preserves the selected background mode');
  }
  await browser.navigate(`${origin}/image`);
  await browser.until(`!!document.querySelector(${JSON.stringify(background)}) && !document.querySelector(${JSON.stringify(background)}).disabled`, 'Background is available');
  await selectModel('Qwen Image 2.1');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(background)}).getAttribute('aria-label')`), 'Background: Auto');
  const prompt = 'A clean cutout of a ceramic teapot.';
  await browser.fill('#image-prompt', prompt);
  for (const width of [1440, 390, 320]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: width === 1440 ? 960 : 844, deviceScaleFactor: 1, mobile: width < 768 });
    await browser.evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))");
    await browser.evaluate("document.querySelector('button[aria-label^=\"Model:\"]').parentElement.parentElement.scrollLeft = 0");
    assert.equal(await browser.evaluate("(() => { const model = document.querySelector('button[aria-label^=\"Model:\"]'), row = model.parentElement.parentElement, bounds = row.getBoundingClientRect(); return ['Model:', 'Aspect ratio:', 'Quality:'].every(label => { const rect = document.querySelector('button[aria-label^=\"' + label + '\"]').getBoundingClientRect(); return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1; }) && document.documentElement.scrollWidth <= innerWidth; })()"), true, `Model, Aspect and Quality stay visible at ${width}px`);
    await browser.click(background);
    await browser.until("document.activeElement?.getAttribute('role') === 'menuitem' && !!document.activeElement.closest('[popover]:popover-open') && getComputedStyle(document.activeElement).visibility === 'visible'", 'Background receives menu focus');
    await browser.evaluate("Promise.all(document.querySelector('[popover]:popover-open').getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => true)");
    assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('[popover]:popover-open [role=menuitem]')].map(row => ({name:row.getAttribute('aria-label'),disabled:row.disabled}))"), [{ name: 'Background Auto', disabled: false }, { name: 'Background Opaque', disabled: false }, { name: 'Background Transparent', disabled: false }]);
    assert.match(await browser.evaluate<string>("document.querySelector('[popover]:popover-open [aria-label=\"Background Transparent\"]').textContent"), /Native transparency/);
    assert.equal(await browser.evaluate("(() => { const menu = document.querySelector('[popover]:popover-open'), rect = menu.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1 && menu.scrollWidth <= menu.clientWidth; })()"), true, `Background menu fits at ${width}px`);
    await browser.screenshot(join(output, `background-qwen-${width}.png`));
    await browser.key('End');
    assert.equal(await browser.evaluate("document.activeElement?.getAttribute('aria-label')"), 'Background Transparent', 'Keyboard navigation reaches transparency');
    await browser.key('Enter');
    await browser.until("!!document.querySelector('button[aria-label=\"Background: Transparent\"]') && !document.querySelector('[popover]:popover-open')", 'The keyboard selects transparency');
    assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), prompt, 'Background changes preserve the prompt');
    await browser.click(reset);
    await browser.until("!!document.querySelector('button[aria-label=\"Background: Auto\"]') && document.querySelector('button[aria-label=\"Reset settings to defaults\"]').disabled", 'Reset restores the default background');
  }
  await selectBackground('Transparent');
  await browser.until(`JSON.parse(localStorage.getItem(${JSON.stringify(draftKey)})).background === 'transparent'`, 'Background is persisted in the draft');
  await browser.send('Page.reload');
  await browser.until("!!document.querySelector('button[aria-label=\"Background: Transparent\"]:not(:disabled)')", 'A page reload restores the selected background');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), prompt);
  await submit(1, 'transparent', 'qwen-image-2.1');
  await browser.until("!!document.querySelector('main figure img.image-checkerboard')", 'The transparent result uses a checkerboard in the gallery');
  await selectBackground('Opaque');
  await browser.fill('#image-prompt', 'A temporary replacement draft.');
  await browser.click('button[aria-label="Open Qwen Image 2.1 output"]');
  await browser.until("document.querySelector('#output-viewer[open] [aria-label=\"Image zoom and pan\"] img')?.naturalWidth > 0", 'The alpha result opens');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#output-viewer dl > div')].find(row => row.querySelector('dt').textContent === 'Background')?.querySelector('dd').textContent"), 'Transparent', 'Result details retain the background mode');
  assert.match(await browser.evaluate<string>("getComputedStyle(document.querySelector('#output-viewer [aria-label=\"Image zoom and pan\"] img')).backgroundImage"), /conic-gradient/, 'The viewer shows alpha over the shared checkerboard');
  await browser.screenshot(join(output, 'background-transparent-viewer-mobile.png'));
  await browser.evaluate("[...document.querySelectorAll('#output-viewer button')].find(button => button.textContent.trim() === 'Use these settings').click()");
  await browser.until("!document.querySelector('#output-viewer[open]') && !!document.querySelector('button[aria-label=\"Background: Transparent\"]')", 'Reuse restores transparency');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), prompt, 'Reuse restores the original prompt with its background');
  await selectModel('FLUX.2 Klein 4B');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(background)}).getAttribute('aria-label')`), 'Background: Transparent', 'Switching models preserves the selected background');
  await browser.click(background);
  assert.match(await browser.evaluate<string>("document.querySelector('[popover]:popover-open [aria-label=\"Background Transparent\"]').textContent"), /Remove background after generation/);
  await browser.key('Escape');
  await submit(2, 'transparent', 'flux-2-klein-4b');
  await selectModel('WAI Illustrious v17');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(background)}).getAttribute('aria-label')`), 'Background: Transparent', 'An unavailable model does not silently discard the requested mode');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(generate)}).disabled`), true, 'Unavailable transparency blocks submission');
  await browser.until(`document.querySelector('[data-workspace-scroll="dock"] [role=alert]')?.textContent.includes(${JSON.stringify(unavailable)})`, 'Missing removal support explains how to recover');
  await browser.click(background);
  assert.equal(await browser.evaluate("document.querySelector('[popover]:popover-open [aria-label=\"Background Transparent\"]').disabled"), true, 'Unavailable transparency is disabled');
  assert.match(await browser.evaluate<string>("document.querySelector('[popover]:popover-open [aria-label=\"Background Transparent\"]').textContent"), /Install BiRefNet from Models/);
  await browser.until("document.activeElement?.getAttribute('role') === 'menuitem' && !!document.activeElement.closest('[popover]:popover-open') && getComputedStyle(document.activeElement).visibility === 'visible'", 'The unavailable-background menu receives focus');
  await browser.key('End');
  assert.equal(await browser.evaluate("document.activeElement?.getAttribute('aria-label')"), 'Background Opaque', 'Keyboard navigation skips the unavailable option');
  await browser.key('Enter');
  await submit(3, 'opaque', 'wai-illustrious-v17');
  await browser.click(reset);
  await browser.until("!!document.querySelector('button[aria-label=\"Background: Auto\"]')", 'Reset restores Auto after an opaque result');
  await submit(4, 'auto', 'wai-illustrious-v17');
  assert.equal(fixture.store.jobs(fixture.owner.id).length, 0, 'UI readiness fixtures never create real generation jobs');
  assert.equal(fixture.workers[0].state.submissions.length, 0, 'UI background checks never submit fake inference to ComfyUI');
  assert.deepEqual(browser.errors, []);
});

test('account drawer persists profiles, preserves conflicting drafts and clears private state on sign out', { timeout: 120000 }, async t => {
  const fixture = await engineFixture({ count: 1 });
  const output = join(root, '.local/screenshots'); await mkdir(output, { recursive: true });
  const frontendPort = await freePort();
  const origin = `http://127.0.0.1:${frontendPort}`;
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, allowedOrigins: [origin], setupSecret: 'account-browser-fixture' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fixture.engine.start();
  let logs = '';
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  t.after(async () => {
    child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL');
    await server.closeOperations(); await close(server); await fixture.close();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ }
    if (child.exitCode !== null || attempt === 99) throw new Error(`Account frontend could not start: ${logs}`);
    await delay(100);
  }
  const browser = await openBrowser(t);
  let cookie = createSession(fixture.store, fixture.owner, false).split(';')[0];
  async function setSessionCookie() { await browser.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' }); }
  await setSessionCookie();
  await browser.navigate(`${origin}/image`);
  await browser.until("!!document.querySelector('#image-prompt') && !!document.querySelector('button[aria-label=\"Account\"]') && !document.querySelector('dialog[open]')", 'The authenticated workspace loads');

  type Profile = { revision: number; displayName: string; workspaceName: string; avatarTheme: string };
  async function profile() {
    const response = await fetch(`${backend}/api/account`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return await response.json() as Profile;
  }
  async function updateProfile(value: Profile) {
    const response = await fetch(`${backend}/api/account`, { method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200);
    return await response.json() as Profile;
  }
  const displayName = '#account-panel input[name="displayName"]';
  const value = (selector: string) => browser.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).value`);
  async function panelButton(label: string) {
    const expression = `Array.from(document.querySelectorAll('#account-panel button')).find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
    await browser.until(`!!(${expression}) && !(${expression}).disabled`, `Account action ${label}`);
    await browser.evaluate(`(${expression}).focus()`); await browser.key('Enter');
  }
  async function openAccount() {
    await browser.click('button[aria-label="Account"]');
    await browser.until(`document.querySelector('#account-panel[open]') && document.querySelector(${JSON.stringify(displayName)}) && !document.querySelector(${JSON.stringify(displayName)}).matches(':disabled')`, 'The account profile is ready');
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('#account-panel').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)");
  }
  async function closed() { await browser.until("!document.querySelector('#account-panel[open]')", 'The account drawer closes'); }
  async function instrumentRequests() {
    await browser.evaluate(`(() => {
      window.__gravityAccountFetch = window.fetch;
      window.__gravityAccountRequests = { saves: 0, uploads: 0, failNext: false, holdNextRead: false, readHeld: false };
      window.fetch = async (input, options = {}) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = String(options.method || 'GET').toUpperCase();
        if (url.origin === location.origin && url.pathname === '/api/inputs' && method === 'POST') window.__gravityAccountRequests.uploads++;
        if (url.origin === location.origin && url.pathname === '/api/account' && method === 'PUT') {
          window.__gravityAccountRequests.saves++;
          if (window.__gravityAccountRequests.failNext) { window.__gravityAccountRequests.failNext = false; return Response.json({error: {message: 'Profile save temporarily unavailable.'}}, {status: 503}); }
        }
        const response = await window.__gravityAccountFetch.call(window, input, options);
        if (url.origin === location.origin && url.pathname === '/api/account' && method === 'GET' && window.__gravityAccountRequests.holdNextRead) {
          window.__gravityAccountRequests.holdNextRead = false;
          const body = await response.json();
          window.__gravityAccountRequests.readHeld = true;
          await new Promise(resolve => { window.__gravityReleaseAccountRead = resolve; });
          return Response.json(body, {status: response.status});
        }
        return response;
      };
    })()`);
  }
  await instrumentRequests();
  const initial = await profile();
  await openAccount();
  assert.equal(await value(displayName), initial.displayName);
  assert.equal(await browser.evaluate("!!document.querySelector('#account-panel #account-workspace-heading')"), false, 'Account has no Workspace section');
  assert.equal(await browser.evaluate("!!document.querySelector('#account-panel input[name=\"workspaceName\"]')"), false, 'Account has no workspace name field');
  assert.equal(await browser.evaluate("document.querySelector('#account-panel input[name=\"username\"]').readOnly"), true, 'The login username cannot be changed through the profile form');
  assert.equal(await value('#account-panel input[name="username"]'), fixture.owner.username);
  assert.equal(await browser.evaluate("document.querySelectorAll('#account-panel [aria-label=\"Avatar color\"] input[type=radio]').length"), 6, 'All six avatar colors are available');

  await browser.fill(displayName, 'Ada Lovelace');
  await browser.click('#account-panel input[type="radio"][value="mint"]');
  await panelButton('Save changes'); await closed();
  const saved = await profile();
  assert.deepEqual({ displayName: saved.displayName, workspaceName: saved.workspaceName, avatarTheme: saved.avatarTheme }, { displayName: 'Ada Lovelace', workspaceName: initial.workspaceName, avatarTheme: 'mint' }, 'Profile edits preserve the stored workspace name');
  assert.equal(saved.revision, initial.revision + 1);
  assert.match(await browser.evaluate<string>("document.querySelector('button[aria-label=\"Account\"]').textContent"), /AL/, 'Saving updates the avatar initials in the header');

  await browser.navigate(`${origin}/image`);
  await browser.until("!!document.querySelector('#image-prompt') && !window.__gravityAccountRequests", 'A fresh page loads the saved account');
  await instrumentRequests(); await openAccount();
  assert.equal(await value(displayName), saved.displayName, 'The display name survives a full page reload');
  assert.equal((await profile()).workspaceName, initial.workspaceName, 'The stored workspace name survives profile edits and a full page reload');
  assert.equal(await browser.evaluate("document.querySelector('#account-panel input[type=radio][value=mint]').checked"), true);

  await browser.fill(displayName, 'Discard this profile draft');
  await panelButton('Cancel'); await closed(); await openAccount();
  assert.equal(await value(displayName), saved.displayName, 'Cancel discards unfinished profile edits');
  await browser.fill(displayName, 'Keep this closed drawer draft');
  await browser.key('Escape'); await closed();
  assert.equal(await browser.evaluate("document.activeElement?.getAttribute('aria-label')"), 'Account', 'Escape returns focus to the account trigger');
  await openAccount();
  assert.equal(await value(displayName), 'Keep this closed drawer draft', 'Escape preserves the unfinished draft');
  const backdrop = await browser.evaluate<{ x: number; y: number }>("(() => { const rect = document.querySelector('#account-panel').getBoundingClientRect(); return [{x: 2, y: 2}, {x: innerWidth - 2, y: 2}].find(point => point.x < rect.left || point.x > rect.right) || null; })()");
  assert.ok(backdrop, 'The desktop drawer leaves a dismissible backdrop');
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...backdrop, button: 'left', clickCount: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...backdrop, button: 'left', clickCount: 1 });
  await closed(); await openAccount();
  assert.equal(await value(displayName), 'Keep this closed drawer draft', 'Backdrop dismissal preserves the unfinished draft');
  await panelButton('Cancel'); await closed(); await openAccount();

  await browser.evaluate("Array.from(document.querySelectorAll('#account-panel button, #account-panel input')).filter(element => !element.disabled && element.getClientRects().length).at(-1).focus()");
  await browser.key('Tab');
  assert.equal(await browser.evaluate("!!document.activeElement?.closest('#account-panel')"), true, 'Tab stays inside the modal drawer');
  await browser.evaluate("Array.from(document.querySelectorAll('#account-panel button, #account-panel input')).find(element => !element.disabled && element.getClientRects().length).focus()");
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  assert.equal(await browser.evaluate("!!document.activeElement?.closest('#account-panel')"), true, 'Shift+Tab stays inside the modal drawer');

  const beforeInvalid = await browser.evaluate<number>('window.__gravityAccountRequests.saves');
  await browser.fill(displayName, '');
  await browser.evaluate("document.querySelector('#account-panel form').requestSubmit()");
  await browser.until(`document.querySelector('#account-panel[open]') && (document.querySelector(${JSON.stringify(displayName)}).matches(':invalid') || document.querySelector('#account-panel [role=alert]'))`, 'An empty display name is rejected in the drawer');
  assert.equal(await browser.evaluate<number>('window.__gravityAccountRequests.saves'), beforeInvalid, 'Required fields are validated before contacting the server');
  await browser.fill(displayName, 'Recovered Profile');
  await browser.evaluate('window.__gravityAccountRequests.failNext = true');
  await panelButton('Save changes');
  await browser.until("document.querySelector('#account-panel[open] [role=alert]')?.textContent.includes('temporarily unavailable')", 'Save failures remain actionable in the drawer');
  assert.equal(await value(displayName), 'Recovered Profile', 'A failed save preserves the edited name');
  assert.equal((await profile()).displayName, saved.displayName, 'A failed save does not change the stored profile');
  await panelButton('Save changes'); await closed();

  await openAccount();
  await browser.fill(displayName, 'Keep my conflicting draft');
  const otherClient = await updateProfile({ ...await profile(), displayName: 'Saved by another browser', workspaceName: 'Shared Workspace', avatarTheme: 'blue' });
  await panelButton('Save changes');
  await browser.until("!!Array.from(document.querySelectorAll('#account-panel button')).find(button => button.textContent.trim() === 'Reload saved profile') && !!document.querySelector('#account-panel [role=alert]')", 'A stale account revision offers an explicit reload');
  assert.equal(await value(displayName), 'Keep my conflicting draft', 'A conflict never replaces the unfinished draft silently');
  assert.equal((await profile()).revision, otherClient.revision, 'The rejected stale save cannot overwrite another browser');
  assert.equal((await profile()).workspaceName, otherClient.workspaceName, 'A conflicting save preserves the workspace name from another browser');
  await panelButton('Reload saved profile');
  await browser.until(`document.querySelector(${JSON.stringify(displayName)}).value === 'Saved by another browser'`, 'Explicit reload loads the saved profile');
  await browser.fill(displayName, 'Final Profile'); await panelButton('Save changes'); await closed();
  const finalProfile = await profile();
  assert.equal(finalProfile.displayName, 'Final Profile', 'Saving can retry after a conflict has been resolved');
  assert.equal(finalProfile.workspaceName, otherClient.workspaceName, 'Saving after an explicit reload preserves the latest stored workspace name');

  await openAccount();
  const bytes = Buffer.from(fixture.workers[0].state.outputBytes).toString('base64');
  const prevented = await browser.evaluate<boolean[]>(`(() => ['dragover', 'drop', 'paste'].map(type => {
    const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(bytes)}), character => character.charCodeAt(0))], 'blocked-account.png', {type: 'image/png'}));
    const event = type === 'paste' ? new ClipboardEvent('paste', {clipboardData: transfer, bubbles: true, cancelable: true}) : new DragEvent(type, {dataTransfer: transfer, bubbles: true, cancelable: true});
    document.dispatchEvent(event); return event.defaultPrevented;
  }))()`);
  assert.deepEqual(prevented.slice(0, 2), [true, true], 'File drags cannot navigate away while Account is open');
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  assert.equal(await browser.evaluate('window.__gravityAccountRequests.uploads'), 0, 'An account drawer never uploads files into the workspace behind it');
  assert.equal(await browser.evaluate("!!document.querySelector('[data-file-drop-target]')"), false);
  assert.equal(await browser.evaluate('location.pathname'), '/image');
  assert.equal(fixture.store.inputs(fixture.owner.id).length, 0);

  assert.equal(await browser.evaluate("!!document.querySelector('#account-panel [aria-label=\"Play a sound when a generation is ready\"]') && !!document.querySelector('#account-panel [aria-label=\"Show a desktop notification when a generation is ready\"]')"), true, 'Account reuses the real controls for completion alerts on this device');
  for (const mobile of [false, true]) {
    const width = mobile ? 390 : 1440, height = mobile ? 844 : 960;
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await browser.evaluate("Promise.all([document.fonts.ready, ...document.querySelector('#account-panel').getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))");
    assert.equal(await browser.evaluate("(() => { const dialog = document.querySelector('#account-panel'), rect = dialog.getBoundingClientRect(); return rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 && dialog.scrollWidth <= dialog.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })()"), true, `Account fits the ${mobile ? 'mobile' : 'desktop'} viewport without horizontal overflow`);
    if (mobile) assert.equal(await browser.evaluate("(() => { const rect = document.querySelector('#account-panel').getBoundingClientRect(); return rect.width >= innerWidth - 2 && rect.height >= innerHeight - 2; })()"), true, 'The mobile account drawer uses the full screen');
    await browser.screenshot(join(output, `account-${mobile ? 'mobile' : 'desktop'}.png`));
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  const privateDraft = 'Unsaved private account draft';
  await updateProfile(await profile());
  await browser.fill(displayName, privateDraft);
  await panelButton('Save changes');
  await browser.until("!!Array.from(document.querySelectorAll('#account-panel button')).find(button => button.textContent.trim() === 'Reload saved profile')", 'A second browser revision makes the sign-out reload stale');
  await browser.evaluate('window.__gravityAccountRequests.holdNextRead = true');
  await panelButton('Reload saved profile');
  await browser.until('window.__gravityAccountRequests.readHeld', 'The saved profile response is in flight when signing out');
  await browser.evaluate("void (window.__gravityAccountDialogBeforeSignout = document.querySelector('#account-panel'))");
  await panelButton('Sign out');
  await browser.until("document.body.innerText.includes('Welcome back.')", 'The real sign-out endpoint ends the owner session');
  await browser.evaluate("window.__gravityReleaseAccountRead(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  assert.equal(await browser.evaluate("!!document.querySelector('#account-panel') || window.__gravityAccountDialogBeforeSignout.isConnected"), false, 'Signing out removes the account drawer and its private draft tree');
  assert.equal(await browser.evaluate("document.body.innerText.includes('Welcome back.')"), true, 'A late profile response cannot restore private UI after signing out');
  assert.equal(await browser.evaluate(`JSON.stringify({...localStorage, ...sessionStorage}).includes(${JSON.stringify(privateDraft)})`), false, 'The account draft is never retained in browser storage');
  assert.equal((await fetch(`${backend}/api/account`, { headers: { Cookie: cookie } })).status, 401, 'The old session cannot read account details after signing out');
  cookie = createSession(fixture.store, fixture.owner, false).split(';')[0]; await setSessionCookie();
  await browser.navigate(`${origin}/image`);
  await browser.until("!!document.querySelector('#image-prompt') && !document.querySelector('dialog[open]')", 'A new owner session opens a clean workspace');
  await openAccount();
  assert.equal(await value(displayName), 'Final Profile', 'A new session loads the saved profile without restoring the signed-out draft');
  assert.equal(fixture.store.jobs(fixture.owner.id).length, 0, 'Account regression never submits a generation');
  assert.deepEqual(browser.errors, []);
});
