import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { createSession } from '../../apps/server/auth.ts';
import { createStudioServer } from '../../apps/server/http.ts';
import { ModelLibrary } from '../../apps/server/models.ts';
import { inputBytes } from '../../apps/server/media.ts';
import { generationExtensionRegistry, saveImportedExtension } from '../../apps/server/registry.ts';
import { getModel, type GenerationExtensionManifest, type NodeInfo } from '../../packages/inference/index.ts';
import { isImageToolInput } from '../../packages/contracts/index.ts';
import { completed } from '../inference/fake-comfy.ts';
import signatures from '../inference/fixtures/comfy-v0.39.0-signatures.json' with { type: 'json' };
import editingNodes from '../inference/fixtures/editing-object-info.json' with { type: 'json' };
import { engineFixture, GiB, until } from '../server/helpers/engine-fixture.ts';
import { openBrowser } from './helpers.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const studio = join(root, 'apps/studio');
const sharp = createRequire(new URL('../../apps/server/package.json', import.meta.url))('sharp');
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = (server.address() as AddressInfo).port; await close(server); return port; }

test('source editing, adapters and native captions survive real API submissions, draft restoration and reuse', { timeout: 180000 }, async t => {
  const fixture = await engineFixture();
  const output = join(root, '.local/screenshots'); await mkdir(output, { recursive: true });
  const state = fixture.workers[0].state;
  const modelIds = ['sdxl-base', 'ideogram-4-fp8'];
  const artifacts = modelIds.flatMap(id => getModel(id).artifacts);
  // The fixture exposes pinned node signatures and files; it performs no diffusion.
  for (const [name, node] of Object.entries(signatures.nodes)) {
    state.info[name] = { input: { required: Object.fromEntries(Object.entries(node.required).map(([key, type]) => [key, [type]])), optional: Object.fromEntries(Object.entries(node.optional).map(([key, type]) => [key, [type]])) }, output: node.outputs };
  }
  Object.assign(state.info, structuredClone(editingNodes) as Record<string, NodeInfo>);
  state.info.ImageScale.input!.required!.upscale_method = [['lanczos', 'bicubic', 'nearest-exact']];
  const lora = (id: string, name: string): GenerationExtensionManifest => ({ id, name, revision: '1', kind: 'lora', category: 'image', description: 'Browser protocol fixture.', familyIds: ['sdxl'], artifacts: [{ role: 'lora', folder: 'loras', filename: `${id}.safetensors` }], memory: { ramBytes: GiB, vramBytes: GiB } });
  const ready = lora('browser-ready-lora', 'Installed ceramic style'), missing = lora('browser-missing-lora', 'Unavailable paper style');
  saveImportedExtension(fixture.store, ready); saveImportedExtension(fixture.store, missing);
  artifacts.push(...ready.artifacts);
  for (const [node, field, folder] of [['CheckpointLoaderSimple', 'ckpt_name', 'checkpoints'], ['UNETLoader', 'unet_name', 'diffusion_models'], ['CLIPLoader', 'clip_name', 'text_encoders'], ['VAELoader', 'vae_name', 'vae'], ['LoraLoader', 'lora_name', 'loras'], ['LoraLoaderModelOnly', 'lora_name', 'loras']] as const) {
    state.info[node].input!.required![field] = [artifacts.filter(artifact => artifact.folder === folder).map(artifact => artifact.filename)];
  }
  const previous = state.responseOverride;
  state.responseOverride = path => path.startsWith('/models/') ? { body: JSON.stringify(artifacts.filter(artifact => artifact.folder === path.slice('/models/'.length)).map(artifact => artifact.filename)) } : previous?.(path);
  fixture.stats[0].devices[0].vram_total = 64 * GiB; fixture.stats[0].devices[0].vram_free = 64 * GiB;
  const settings = fixture.store.settings();
  for (const configuration of settings.modelConfigurations) { configuration.enabled = modelIds.includes(configuration.modelId); configuration.workerIds = configuration.enabled ? ['worker-0'] : []; if (configuration.enabled) configuration.memory = { ramBytes: 8 * GiB, vramBytes: 6 * GiB, source: 'estimate' }; }
  fixture.store.saveSettings(settings);
  const bytes = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512"><rect width="768" height="512" fill="#324146"/><rect x="220" y="110" width="328" height="292" rx="45" fill="#c6b097"/><text x="384" y="470" font-family="sans-serif" text-anchor="middle" fill="#ffffff" font-size="22">Source editing fixture</text></svg>')).png().toBuffer();
  state.outputBytes = bytes;
  const completion = setInterval(() => { for (const prompt of state.pending.splice(0)) state.history[String(prompt[1])] = completed(prompt); }, 80);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const importUrl = 'https://huggingface.co/gravity-fixtures/browser-lora/blob/main/ceramic.safetensors';
  const header = Buffer.from(JSON.stringify({ 'fixture.lora': { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  const loraBytes = Buffer.concat([prefix, header, Buffer.alloc(4)]);
  let downloadRequests = 0;
  const library = new ModelLibrary(fixture.store, fixture.engine, { fetch: async (input, init) => {
    assert.equal(String(input), importUrl.replace('/blob/', '/resolve/'), 'Imports use only the synthetic upstream file');
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': String(loraBytes.length) } });
    downloadRequests++; return new Response(loraBytes, { headers: { 'Content-Length': String(loraBytes.length) } });
  } });
  const server = await createStudioServer({ store: fixture.store, engine: fixture.engine, models: library, allowedOrigins: [origin], setupSecret: 'image-capabilities-fixture' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fixture.engine.start();
  let logs = '';
  const child = spawn(process.execPath, [join(studio, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: studio, env: { ...process.env, GRAVITY_SERVER_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); }); child.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
  t.after(async () => { clearInterval(completion); child.kill('SIGTERM'); await delay(200); if (child.exitCode === null) child.kill('SIGKILL'); await server.closeOperations(); await close(server); await fixture.close(); });
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch { /* Starting. */ } if (child.exitCode !== null || attempt === 99) throw new Error(`Capabilities frontend could not start: ${logs}`); await delay(100); }
  const cookie = createSession(fixture.store, fixture.owner, false).split(';')[0];
  const catalog = await (await fetch(`${backend}/api/catalog`, { headers: { Cookie: cookie } })).json() as { models: Array<{ id: string; ready: boolean; capabilities: { editing: { inpaint: { available: boolean } } }; missingReasons: string[] }> };
  for (const id of modelIds) assert.equal(catalog.models.find(model => model.id === id)?.ready, true, `The protocol fixture exposes ${id}`);
  assert.equal(catalog.models.find(model => model.id === 'sdxl-base')?.capabilities.editing.inpaint.available, true);
  const browser = await openBrowser(t);
  await browser.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=')[1], url: origin, httpOnly: true, sameSite: 'Strict' });
  await browser.navigate(`${origin}/image`);
  await browser.until('!!document.querySelector("button[aria-label=\\"Model: SDXL Base 1.0\\"]") && !document.querySelector("dialog[open]")', 'The isolated workspace opens');
  const draftExpression = `JSON.parse(localStorage.getItem(${JSON.stringify(`gravity:image-draft:${fixture.owner.id}`)}) || '{}')`;
  async function draft() { return browser.evaluate<Record<string, unknown>>(draftExpression); }
  async function openEditor() { await browser.click('button[aria-label="Edit reference 1"]'); await browser.until('!!document.querySelector("#reference-editor[open]")', 'Reference editor opens'); }
  async function openAdvanced() { await browser.click('button[aria-label="Advanced settings"]'); await browser.until('!!document.querySelector("[aria-label=\\"Advanced settings\\"]:popover-open")', 'Advanced settings opens'); }
  async function selectModel(name: string) {
    await browser.click('button[aria-label^="Model:"]');
    const choice = `Array.from(document.querySelectorAll('[role="menuitem"]')).find(button => button.textContent.startsWith(${JSON.stringify(name)}))`;
    await browser.until(`!!(${choice})`, `Model choice ${name}`);
    await browser.evaluate("document.querySelectorAll('[data-capabilities-model-choice]').forEach(button => button.removeAttribute('data-capabilities-model-choice'))");
    await browser.evaluate(`(${choice}).setAttribute('data-capabilities-model-choice', 'true')`);
    await browser.click('[data-capabilities-model-choice]');
    await browser.until(`document.querySelector('button[aria-label^="Model:"]')?.getAttribute('aria-label') === ${JSON.stringify(`Model: ${name}`)}`, `Select ${name}`);
  }
  async function frame() { await browser.evaluate('Promise.all([document.fonts.ready,...document.getAnimations().map(animation => animation.finished.catch(() => {}))]).then(() => true)'); }
  async function generate(prompt: string) {
    await browser.fill('#image-prompt', prompt); await browser.click('button[title^="Submit to your generation queue"]');
    await until(() => fixture.store.jobs().some(job => job.prompt === prompt), 'Browser submission reaches the real queue', 10000);
    const job = fixture.store.jobs().find(job => job.prompt === prompt)!;
    await until(() => fixture.store.job(job.id).status === 'succeeded', 'Protocol output is saved', 10000);
    return fixture.store.job(job.id);
  }
  // Upload through the same owned-input endpoint used by the file picker.
  await browser.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), char => char.charCodeAt(0))], 'ceramic-source.png', {type:'image/png'})); document.querySelector('#image-prompt').dispatchEvent(new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true})); })()`);
  await browser.until('!!document.querySelector("button[aria-label=\\"Edit reference 1\\"]")', 'The owned image becomes an editable reference');
  const source = fixture.store.inputs(fixture.owner.id).find(input => input.name === 'ceramic-source.png')!; assert.ok(source);
  await openEditor(); await browser.click('#reference-tab-mask');
  const canvas = '#reference-editor canvas';
  await browser.until(`!!document.querySelector(${JSON.stringify(canvas)})`, 'A paintable mask canvas appears');
  const point = await browser.evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector(${JSON.stringify(canvas)}).getBoundingClientRect(); return {x:rect.left+rect.width*.5,y:rect.top+rect.height*.5}; })()`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 60, y: point.y + 12, buttons: 1, button: 'left' });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 60, y: point.y + 12, button: 'left', clickCount: 1 });
  const maskPainted = `(() => { const canvas = document.querySelector(${JSON.stringify(canvas)}); return canvas && Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data).some((value,index) => index%4===3 && value>0); })()`;
  assert.equal(await browser.evaluate(maskPainted), true, 'Pointer painting marks pixels');
  await browser.clickText('Undo'); assert.equal(await browser.evaluate(maskPainted), false, 'Undo restores the unpainted mask');
  await browser.click(canvas); await browser.key('ArrowRight'); await browser.key(' ', 'Space');
  assert.equal(await browser.evaluate(maskPainted), true, 'The keyboard can also paint');
  await frame(); await browser.screenshot(join(output, 'capabilities-mask-desktop.png'));
  await browser.clickText('Apply changes');
  await browser.until(`!!(${draftExpression}).mask && !document.querySelector('#reference-editor[open]')`, 'The saved mask is bound to the draft');
  const saved = await draft(), mask = saved.mask as { id: string; width: number; height: number };
  assert.equal(saved.editSourceId, source.id); assert.equal(saved.matchSource, true);
  assert.deepEqual([mask.width, mask.height], [768, 512]); assert.notEqual(mask.id, source.id);
  const maskBytes = await inputBytes(fixture.store, mask.id, fixture.owner.id);
  const decoded = await sharp(maskBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let white = 0, black = 0;
  for (let index = 0; index < decoded.data.length; index += 4) { assert.equal(decoded.data[index + 3], 255, 'Mask pixels are opaque'); if (decoded.data[index] === 255) white++; else if (decoded.data[index] === 0) black++; }
  assert.ok(white > 100 && black > white, 'The uploaded mask has a bounded white selection and black protected pixels');
  await browser.navigate(`${origin}/image`);
  await browser.until(`!!document.querySelector('#image-prompt') && (${draftExpression}).mask?.id === ${JSON.stringify(mask.id)}`, 'Reload restores the owned mask');
  await openAdvanced();
  await browser.until('!!document.querySelector("select[aria-label=\\"Add LoRA\\"] option[value=browser-ready-lora]")', 'Model-scoped adapters load');
  assert.equal(await browser.evaluate('document.querySelector("option[value=browser-missing-lora]").disabled'), true, 'Undownloaded compatible adapters cannot be selected');
  await browser.fill('select[aria-label="Add LoRA"]', ready.id);
  await browser.fill('input[aria-label="Strength for Installed ceramic style"]', '.65');
  await browser.key('Escape');
  const masked = await generate('Make only the selected ceramic area blue.');
  assert(!isImageToolInput(masked.input));
  assert.equal(masked.input.maskId, mask.id); assert.deepEqual(masked.input.images, [source.id]);
  assert.deepEqual(masked.input.loras, [{ id: ready.id, strength: .65 }]);
  assert.deepEqual([masked.parameters.width, masked.parameters.height], [768, 512]);
  // The real output viewer restores owned sources and their mask together.
  await browser.click('button[aria-label="Remove reference 1"]');
  await browser.until(`!(${draftExpression}).mask`, 'Removing the source clears its bound mask');
  await browser.click('button[aria-label="Open SDXL Base 1.0 output"]');
  await browser.clickText('Use these settings');
  await browser.until(`(${draftExpression}).mask?.id === ${JSON.stringify(mask.id)} && (${draftExpression}).images?.[0]?.id === ${JSON.stringify(source.id)}`, 'Reuse resolves the source and mask from the server');
  // Deleting the current mask in Assets must not turn its protected edit into a redraw.
  await browser.click('header button[aria-label="Assets"]');
  const maskCard = `#assets-browser-dialog article[data-asset-id="${mask.id}"]`;
  await browser.until(`!!document.querySelector(${JSON.stringify(maskCard)})`, 'Assets contains the saved mask');
  await browser.click(`${maskCard} button[aria-label="Delete image"]`);
  await browser.click(`${maskCard} button[aria-label="Confirm image deletion"]`);
  await browser.until(`(${draftExpression}).missingMaskId === ${JSON.stringify(mask.id)}`, 'Mask deletion preserves and flags the protected draft');
  assert.equal(fixture.store.inputs(fixture.owner.id).some(input => input.id === mask.id), false, 'The real owned-input deletion completed');
  assert.equal((await draft()).editSourceId, source.id);
  assert.equal(((await draft()).mask as { id: string }).id, mask.id, 'The missing mask stays bound instead of silently broadening the edit');
  await browser.click('button[aria-label="Close assets"]');
  await browser.until("document.body.innerText.includes('The selected mask was deleted.')", 'The draft explains its missing mask');
  assert.equal(await browser.evaluate("document.querySelector('button[title^=\"Submit to your generation queue\"]').disabled"), true);
  const jobsBeforeMissingMask = fixture.store.jobs().length;
  await browser.evaluate("document.querySelector('button[title^=\"Submit to your generation queue\"]').click()");
  await frame(); assert.equal(fixture.store.jobs().length, jobsBeforeMissingMask, 'A disabled generation control cannot dispatch the broader edit');
  await browser.navigate(`${origin}/image`);
  await browser.until(`(${draftExpression}).missingMaskId === ${JSON.stringify(mask.id)} && document.body.innerText.includes('The selected mask was deleted.')`, 'Reload preserves the missing-mask guard');
  await openEditor();
  assert.equal(await browser.evaluate("document.querySelector('#reference-tab-mask').getAttribute('aria-selected')"), 'true', 'Repair opens directly on a fresh mask');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#reference-editor button')).find(button => button.textContent.trim() === 'Apply changes').disabled"), true, 'An empty replacement cannot be applied');
  await browser.click(canvas); await browser.key('ArrowRight'); await browser.key(' ', 'Space');
  await browser.clickText('Apply changes');
  await browser.until(`!(${draftExpression}).missingMaskId && !!(${draftExpression}).mask && (${draftExpression}).mask.id !== ${JSON.stringify(mask.id)}`, 'Painting a replacement restores a valid protected edit');
  const repaired = await generate('Regenerate only the repaired mask area.'); assert(!isImageToolInput(repaired.input));
  assert.notEqual(repaired.input.maskId, mask.id); assert.equal(repaired.input.maskId, ((await draft()).mask as { id: string }).id);
  await openEditor(); await browser.click('#reference-tab-extend');
  await browser.fill('input[aria-label="Extend left"]', '1');
  assert.equal(await browser.evaluate("Array.from(document.querySelectorAll('#reference-editor button')).find(button=>button.textContent.trim()==='Apply changes').disabled"), true, 'Off-grid padding is blocked before submission');
  await browser.fill('input[aria-label="Extend left"]', '128'); await browser.fill('input[aria-label="Extend right"]', '128');
  await browser.until("document.querySelector('#reference-editor').textContent.includes('1024 × 512 canvas')", 'Extension preview uses the resulting native canvas');
  for (const width of [390, 320]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true }); await frame();
    if (width === 390) {
      await browser.click('#reference-tab-mask'); await browser.clickText('Reset mask');
      await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      const touch = await browser.evaluate<{ x: number; y: number }>(`(() => { const rect = document.querySelector(${JSON.stringify(canvas)}).getBoundingClientRect(); return {x:rect.left+rect.width*.35,y:rect.top+rect.height*.5}; })()`);
      await browser.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touch, id: 1 }] });
      await browser.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x + 45, y: touch.y + 10, id: 1 }] });
      await browser.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(await browser.evaluate(maskPainted), true, 'A synthesized Chromium touch stroke paints on the mobile canvas');
      await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await browser.click('#reference-tab-extend'); await frame();
    }
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px has no page overflow`);
    assert.equal(await browser.evaluate("(() => {const dialog=document.querySelector('#reference-editor'),rect=dialog.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight;})()"), true, `${width}px keeps the editor within the viewport`);
    await browser.screenshot(join(output, `capabilities-extend-${width}.png`));
  }
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await browser.clickText('Apply changes');
  const extended = await generate('Extend the ceramic scene naturally.'); assert(!isImageToolInput(extended.input));
  assert.equal(extended.input.maskId, undefined); assert.deepEqual(extended.input.outpaint, { left: 128, right: 128, top: 0, bottom: 0 });
  assert.deepEqual([extended.parameters.width, extended.parameters.height], [1024, 512]);
  await openEditor(); await browser.click('#reference-tab-canvas');
  await browser.clickText('Apply changes');
  const matched = await generate('Keep the exact source proportions.'); assert(!isImageToolInput(matched.input));
  assert.equal(matched.input.matchSource, true); assert.equal(matched.input.outpaint, undefined); assert.deepEqual([matched.parameters.width, matched.parameters.height], [768, 512]);
  await selectModel('Ideogram 4 FP8');
  await browser.until(`!(${draftExpression}).mask && !(${draftExpression}).outpaint && !(${draftExpression}).loras?.length`, 'Changing families clears incompatible editing options and LoRAs');
  await browser.click('button[aria-label="Remove reference 1"]');
  await browser.fill('#image-prompt', 'A poster with CERAMIC written above a blue cup.');
  await openAdvanced(); await browser.click('[aria-label="Advanced settings"]:popover-open summary'); await browser.click('button[role="switch"][aria-label="Use structured prompt"]');
  await browser.fill('textarea[aria-label="Ideogram structured prompt"]', '{broken');
  assert.equal(await browser.evaluate("document.querySelector('button[title^=\"Submit to your generation queue\"]').disabled"), true, 'An invalid native caption cannot enter the queue');
  const caption = { high_level_description: 'A ceramic exhibition poster.', compositional_deconstruction: { background: 'Ivory paper', elements: [{ type: 'text', text: 'CERAMIC', desc: 'Dark blue title', bbox: [80, 150, 240, 850] }, { type: 'obj', desc: 'A blue ceramic cup', bbox: [300, 250, 850, 750] }] } };
  await browser.fill('textarea[aria-label="Ideogram structured prompt"]', JSON.stringify(caption));
  await browser.key('Escape');
  assert.equal(await browser.evaluate("document.querySelector('#image-prompt').value"), caption.high_level_description, 'Native caption editing keeps the dock prompt readable');
  await browser.navigate(`${origin}/image`);
  await browser.until(`(${draftExpression}).structuredPrompt?.includes('CERAMIC') && !!document.querySelector('#image-prompt')`, 'Reload retains the complete native caption');
  await browser.click('button[title^="Submit to your generation queue"]');
  await until(() => fixture.store.jobs().some(job => job.modelId === 'ideogram-4-fp8'), 'The native caption reaches the real queue', 10000);
  const native = fixture.store.jobs().find(job => job.modelId === 'ideogram-4-fp8')!;
  assert.deepEqual(JSON.parse(native.prompt), caption, 'Object bounds and exact lettering survive browser submission');
  await browser.fill('#image-prompt', 'A new plain-language concept.');
  await browser.until(`!(${draftExpression}).structuredPrompt`, 'Editing plain prose clears the stale structured caption');
  // Administrator import UI uses the real downloader with one synthetic upstream file.
  await selectModel('SDXL Base 1.0');
  await openAdvanced();
  await browser.until("!!document.querySelector('option[value=browser-ready-lora]')", 'Advanced reads tools before importing a new adapter');
  await browser.key('Escape');
  await browser.click('header button[aria-label="Settings"]'); await browser.click('#settings-tab-models'); await browser.click('#models-tab-tools');
  await browser.clickText('Import LoRA from Hugging Face');
  assert.equal(await browser.evaluate("document.querySelector('select[aria-label=\"Import type\"]').value"), 'lora');
  await browser.fill('select[aria-label="Model family"]', 'sdxl');
  await browser.fill('input[name="checkpoint-url"]', importUrl); await browser.fill('input[name="checkpoint-name"]', 'Browser SDXL ceramic style');
  await browser.clickText('Download LoRA');
  await until(() => downloadRequests === 1, 'The form downloads its requested LoRA', 10000); await library.waitForIdle();
  const imported = generationExtensionRegistry(fixture.store).find(tool => tool.name === 'Browser SDXL ceramic style')!;
  assert.deepEqual(imported.familyIds, ['sdxl']); assert.ok(imported.artifacts[0].sha256);
  assert.equal(fixture.store.settings().modelConfigurations.some(configuration => configuration.modelId === imported.id), false, 'Importing an adapter does not add an image-generation model');
  await browser.until("document.querySelector('#models-panel-downloads').textContent.includes('Browser SDXL ceramic style')", 'The download result is visible');
  // Model files become visible to the protocol worker after its directory rescan.
  artifacts.push(...imported.artifacts);
  state.info.LoraLoader.input!.required!.lora_name = [artifacts.filter(artifact => artifact.folder === 'loras').map(artifact => artifact.filename)];
  fixture.engine.invalidateWorkers();
  await browser.click('button[aria-label="Close settings"]');
  assert.equal((await draft()).modelId, 'sdxl-base', 'The selected generation model stays unchanged while downloading');
  await openAdvanced();
  await browser.until(`document.querySelector('select[aria-label="Add LoRA"] option[value="${imported.id}"]')?.disabled === false`, 'Reopening Advanced discovers the new ready adapter without a reload or model switch');
  await browser.fill('select[aria-label="Add LoRA"]', imported.id); await browser.key('Escape');
  const adapted = await generate('Use the newly downloaded ceramic style.'); assert(!isImageToolInput(adapted.input));
  assert.deepEqual(adapted.input.loras, [{ id: imported.id, strength: 1 }], 'The imported adapter reaches the next generation');
  assert.deepEqual(browser.errors, []);
  t.diagnostic(`Capability screenshots: ${output}`);
});
