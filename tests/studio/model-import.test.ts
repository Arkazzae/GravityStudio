import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkpointAccessRequest, checkpointImportRequest, presetDependencies } from '../../apps/studio/src/lib/model-import.ts';
import type { ModelImportPreset } from '../../apps/studio/src/lib/api.ts';

const preset: ModelImportPreset = {
  id: 'ideogram-4-fp8', name: 'Ideogram 4 FP8', familyId: 'ideogram-4', revision: '1', primaryRole: 'diffusion',
  dependencyRoles: ['diffusion-unconditional', 'text-encoder', 'vae'], operations: ['text-to-image', 'image-to-image', 'reference'],
  artifacts: [
    { role: 'diffusion', filename: 'model.safetensors' }, { role: 'diffusion-unconditional', filename: 'unconditional.safetensors' },
    { role: 'text-encoder', filename: 'encoder.safetensors' }, { role: 'vae', filename: 'vae.safetensors' },
  ],
  defaults: { steps: 20, cfg: 7 },
};
const fields = { name: ' My model ', url: ' https://huggingface.co/owner/model/blob/main/model.safetensors ', dependencies: {}, textOnly: false };

test('preset imports inherit reviewed files and defaults until explicitly replaced', () => {
  assert.deepEqual(checkpointImportRequest(preset, fields), { presetId: preset.id, name: 'My model', url: fields.url.trim() });
  assert.deepEqual(presetDependencies(preset).map(artifact => artifact.role), ['diffusion-unconditional', 'text-encoder', 'vae']);
});

test('dependency overrides include only advertised nonprimary roles, with no stale values from another preset', () => {
  const dependencies = { diffusion: 'https://example.com/ignored', checkpoint: 'https://example.com/stale', 'text-encoder': ' https://huggingface.co/owner/encoder/blob/main/encoder.safetensors ', vae: '  ' };
  const request = checkpointImportRequest(preset, { ...fields, dependencies });
  assert.deepEqual('dependencies' in request && request.dependencies, [{ role: 'text-encoder', url: dependencies['text-encoder'].trim() }]);
  assert.deepEqual(presetDependencies({ ...preset, dependencyRoles: ['vae'] }).map(artifact => artifact.role), ['vae']);
  assert.deepEqual(presetDependencies({ ...preset, primaryRole: undefined, dependencyRoles: undefined }).map(artifact => artifact.role), ['diffusion-unconditional', 'text-encoder', 'vae']);
});

test('text-only imports can narrow a preset without expanding an image-only preset', () => {
  const request = checkpointImportRequest(preset, { ...fields, textOnly: true });
  assert.deepEqual('operations' in request && request.operations, ['text-to-image']);
  const imageOnly = checkpointImportRequest({ ...preset, operations: ['reference'] }, { ...fields, textOnly: true });
  assert.equal('operations' in imageOnly, false);
});

test('preset access checks receive the entire download request and legacy servers keep URL-only checks', () => {
  const request = checkpointImportRequest(preset, { ...fields, dependencies: { vae: 'https://huggingface.co/owner/vae/blob/main/vae.safetensors' }, textOnly: true });
  assert.deepEqual(checkpointAccessRequest(request), request);
  const legacy = checkpointImportRequest(undefined, fields);
  assert.deepEqual(legacy, { url: fields.url.trim(), name: 'My model', familyId: 'sdxl' });
  assert.deepEqual(checkpointAccessRequest(legacy), { url: fields.url.trim() });
});
