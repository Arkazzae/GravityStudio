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
  const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
  const sharp = require('sharp') as (input: Buffer) => { png(): { toBuffer(): Promise<Buffer> } };
  comfy.state.outputBytes = Uint8Array.from(await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#24323b"/><rect x="70" y="80" width="628" height="864" rx="4" fill="#344b4c"/><text x="384" y="488" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#d1fe17">COMFYUI PROTOCOL FIXTURE</text><text x="384" y="535" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#e8edeb">Browser integration test · no model inference</text></svg>')).png().toBuffer());
  let completeAutomatically = true;
  const completion = setInterval(() => {
    if (!completeAutomatically) return;
    const pending = comfy.state.pending.splice(0);
    for (const prompt of pending) comfy.state.history[String(prompt[1])] = completed(prompt);
  }, 150);
  const frontendPort = await freePort();
  const origin = `http://127.0.0.1:${frontendPort}`;
  let runtimeState: RuntimeSetupStatus = { phase: 'idle', busy: false, message: '', error: null, engine: null, workerCount: 0, updatedAt: null };
  let chosenGpuIds: string[] = [];
  let runtimeOperation: Promise<void> | undefined;
  // Only container execution and the Hugging Face response are fixtures; the owner API,
  // model download, validation, activation, settings and generation use their real code.
  const runtime = {
    status: () => structuredClone(runtimeState),
    start: (body: Record<string, unknown>) => {
      chosenGpuIds = body.gpuIds as string[];
      runtimeState = { ...runtimeState, phase: 'building', busy: true, message: 'Preparing the image engine…' };
      runtimeOperation = delay(750).then(async () => {
        const settings = store.settings();
        settings.workers = [{ id: 'browser-comfy', name: 'GPU 2', baseUrl: comfy.url, enabled: true, deviceIds: chosenGpuIds, location: 'local', maxConcurrentJobs: 1 }];
        store.saveSettings(settings);
        await mkdir(join(directory, 'runtime'), { recursive: true });
        await writeFile(join(directory, 'runtime/plan.json'), JSON.stringify({ workers: settings.workers }));
        runtimeState = { ...runtimeState, phase: 'ready', busy: false, engine: 'podman', workerCount: 1, message: 'Ready', updatedAt: new Date().toISOString() };
      });
      return structuredClone(runtimeState);
    },
    close: async () => { await runtimeOperation; },
  };
  const checkpointUrl = 'https://huggingface.co/gravity-fixtures/browser/blob/main/checkpoint.safetensors';
  const source = checkpointUrl.replace('/blob/', '/resolve/');
  const modelId = `hf-${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
  const filename = `${modelId}/checkpoint.safetensors`;
  comfy.state.info.CheckpointLoaderSimple.input!.required!.ckpt_name = [[filename]];
  comfy.state.responseOverride = path => path === '/models/checkpoints' ? { body: JSON.stringify([filename]) } : undefined;
  const header = Buffer.from(JSON.stringify({ fixture: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  const fixtureCheckpoint = Buffer.concat([prefix, header, Buffer.alloc(4)]);
  const models = new ModelLibrary(store, engine, { fetch: async input => {
    assert.equal(String(input), source); await delay(900);
    return new Response(fixtureCheckpoint, { headers: { 'Content-Length': String(fixtureCheckpoint.length) } });
  } });
  const server = await createStudioServer({ store, engine, runtime, models, allowedOrigins: [origin], setupSecret: 'browser-integration-setup-key' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await engine.start();
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(frontendPort)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-8000); }); child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-8000); });
  t.after(async () => { clearInterval(completion); child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL'); await server.closeOperations(); await engine.stop(); await close(server); await comfy.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
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
  await browser.until("document.querySelector('#models-dialog[open]')?.innerText.includes('Add from Hugging Face')", 'Model library dialog');
  assert.equal(await browser.evaluate("document.querySelector('#models-dialog').matches(':modal') && location.pathname === '/image'"), true, 'Gallery opens Models without navigating away');
  await browser.fill('input[name="checkpoint-url"]', checkpointUrl);
  await browser.fill('input[name="checkpoint-name"]', 'Browser checkpoint');
  await browser.clickText('Download checkpoint');
  await browser.until("document.body.innerText.includes('Browser checkpoint') && !!document.querySelector('progress')", 'Download progress');
  await browser.click('button[aria-label="Close models"]');
  await browser.until("!document.querySelector('#models-dialog[open]')", 'Download continues after closing Models');
  await browser.until("!!document.querySelector('main button[aria-label=\"Model: Browser checkpoint\"]')", 'Background download refreshes the Image model selection');
  assert.equal(store.settings().modelConfigurations.find(item => item.modelId === modelId)?.enabled, true);
  assert.deepEqual(store.settings().modelConfigurations.find(item => item.modelId === modelId)?.workerIds, ['browser-comfy']);
  await browser.click('header button[aria-label="Models"]');
  await browser.until("document.querySelector('#models-dialog[open]')?.innerText.includes('Ready to use')", 'Downloaded checkpoint is activated when Models reopens');
  await browser.evaluate("document.querySelectorAll('#models-dialog, #models-dialog *').forEach(element => { if (getComputedStyle(element).overflowY === 'auto') element.scrollTop = 0; })");
  await browser.screenshot(join(output, 'models-desktop.png'));
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true);
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
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('[popover]:popover-open [role=menuitem]')).find(row => row.textContent.includes('SDXL Base 1.0'))?.disabled"), true, 'A model without installed files cannot be selected');
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
  await browser.click('#reference-picker-dialog button[aria-label^="Use reference:"]');
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
  await browser.screenshot(join(output, 'settings-mobile.png'));
  assert.equal(await browser.evaluate("document.querySelector('[role=tablist][aria-label=\"Settings sections\"]')?.getAttribute('aria-orientation')"), 'vertical', 'Settings has one vertical section navigator');
  async function settingsKey(key: string, section: string) {
    await browser.key(key);
    await browser.until(`document.querySelector('#settings-tab-${section}')?.getAttribute('aria-selected') === 'true' && document.querySelector('#settings-panel-${section}')?.hidden === false`, `${key} selects the ${section} section`);
    assert.equal(await browser.evaluate('document.activeElement?.id'), `settings-tab-${section}`, 'Keyboard navigation moves focus with the selected tab');
    assert.equal(await browser.evaluate(`document.querySelector('#settings-panel-${section}').getAttribute('aria-labelledby')`), `settings-tab-${section}`, 'The selected panel is labelled by its tab');
  }
  await browser.click('#settings-tab-gpus');
  await settingsKey('ArrowDown', 'connections');
  const workerNameInput = '#settings-panel-connections input[maxlength="80"]';
  await browser.fill(workerNameInput, 'Unsaved browser worker');
  await settingsKey('ArrowDown', 'models');
  const checkpointInput = '#settings-panel-models input[list="artifacts-checkpoint"]';
  await browser.fill(checkpointInput, 'unsaved-browser-checkpoint.safetensors');
  await settingsKey('ArrowUp', 'connections');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(workerNameInput)}).value`), 'Unsaved browser worker', 'Changing tabs preserves an unsaved connection name');
  await settingsKey('ArrowDown', 'models');
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(checkpointInput)}).value`), 'unsaved-browser-checkpoint.safetensors', 'Changing tabs preserves an unsaved model filename');
  await settingsKey('Home', 'gpus');
  assert.equal(await browser.evaluate("document.querySelector('#settings-panel-connections').hidden && document.querySelector('#settings-panel-models').hidden"), true, 'Inactive sections remain mounted and hidden');
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

  // Read-only UI fixture: expose three real catalog manifests as selectable without
  // installing their weights. No generation is submitted while readiness is overridden.
  const geometryModels = [
    { id: 'wai-illustrious-v17', name: 'WAI Illustrious v17', short: 'wai' },
    { id: 'flux-2-klein-4b', name: 'FLUX.2 Klein 4B', short: 'klein' },
    { id: 'krea-2-turbo', name: 'Krea 2 Turbo', short: 'krea' },
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
      const ids = new Set(${JSON.stringify(geometryModels.map(model => model.id))});
      window.__gravityOriginalFetch = window.fetch;
      window.fetch = async (input, options) => {
        const response = await window.__gravityOriginalFetch.call(window, input, options);
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.origin !== location.origin || url.pathname !== '/api/catalog' || (options?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET' || !response.ok) return response;
        const catalog = await response.json();
        catalog.models = catalog.models.map(model => ids.has(model.id) ? { ...model, ready: true, capabilities: { ...model.capabilities, ready: true }, missingReasons: [], unavailableReason: '' } : model);
        return new Response(JSON.stringify(catalog), { status: response.status, headers: { 'Content-Type': 'application/json' } });
      };
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    for (const viewport of [{ name: 'desktop', width: 1440, height: 960, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
      let dockBaseline: Geometry | undefined;
      let advancedBaseline: Geometry | undefined;
      await browser.evaluate("void (window.__gravityGeometryPrompt = document.querySelector('#image-prompt'))");
      for (const model of geometryModels) {
        await selectGeometryModel(model.name);
        const bounds = await geometry(dockSelectors);
        if (dockBaseline) sameGeometry(bounds, dockBaseline, `${viewport.name} ${model.name}`);
        else dockBaseline = bounds;
        assert.ok(Math.abs(bounds.model.width - (viewport.mobile ? 160 : 184)) < .1);
        assert.ok(bounds.aspect.width > 44 && bounds.aspect.width < 80, 'The aspect chip fits its icon and label without a fixed width');
        assert.ok(Math.abs(bounds.model.height - 36) < .1); assert.ok(Math.abs(bounds.aspect.height - 36) < .1);
        for (const action of ['add', 'browse']) { assert.ok(Math.abs(bounds[action].width - 40) < .1); assert.ok(Math.abs(bounds[action].height - 40) < .1); }
        assert.equal(await browser.evaluate(`document.querySelector('#image-prompt') === window.__gravityGeometryPrompt && document.querySelector('#image-prompt').value === ${JSON.stringify(geometryPrompt)}`), true, 'Model changes preserve the same prompt element and text');
        const noReferences = model.short === 'krea';
        for (const selector of [dockSelectors.add, dockSelectors.browse, 'input[aria-label="Upload reference images"]']) {
          assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`), noReferences, `${model.name} advertises its reference capability`);
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
        assert.equal(await browser.evaluate("!!document.querySelector('[popover]:popover-open textarea[aria-label=\"Negative prompt\"]')"), model.short === 'wai', 'Only models advertising negative prompts expose the field');
        await screenshotPopover(`advanced-${model.short}-${viewport.name}.png`);
        await browser.key('Escape');
      }
    }
    assert.equal(store.jobs(store.owner()!.id).length, jobCount, 'The geometry fixture creates no generation jobs');
    assert.equal(comfy.state.submissions.length, submissionCount, 'The geometry fixture submits no ComfyUI prompts');
  } finally {
    await browser.evaluate(`(() => { if (window.__gravityOriginalFetch) { window.fetch = window.__gravityOriginalFetch; delete window.__gravityOriginalFetch; } delete window.__gravityGeometryPrompt; ${savedDraft === null ? `localStorage.removeItem(${JSON.stringify(draftKey)});` : `localStorage.setItem(${JSON.stringify(draftKey)}, ${JSON.stringify(savedDraft)});`} })()`);
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
