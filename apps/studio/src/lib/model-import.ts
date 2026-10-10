import type { CheckpointImportRequest, LegacyCheckpointImportRequest, ModelImportPreset } from './api.ts';

export function presetDependencies(preset: ModelImportPreset): ModelImportPreset['artifacts'] {
  const primary = preset.primaryRole || preset.artifacts.find(artifact => artifact.role === 'checkpoint' || artifact.role === 'diffusion')?.role;
  return preset.artifacts.filter(artifact => artifact.role !== primary && (!preset.dependencyRoles || preset.dependencyRoles.includes(artifact.role)));
}

export function checkpointImportRequest(preset: ModelImportPreset | undefined, input: { name: string; url: string; dependencies: Record<string, string>; textOnly: boolean }): CheckpointImportRequest | LegacyCheckpointImportRequest {
  const name = input.name.trim(), url = input.url.trim();
  if (!preset) return { url, name, familyId: 'sdxl' };
  const dependencies = presetDependencies(preset).flatMap(artifact => {
    const replacement = input.dependencies[artifact.role]?.trim();
    return replacement ? [{ role: artifact.role, url: replacement }] : [];
  });
  return {
    presetId: preset.id, name, url,
    ...(dependencies.length ? { dependencies } : {}),
    ...(input.textOnly && preset.operations.includes('text-to-image') && preset.operations.some(operation => operation !== 'text-to-image') ? { operations: ['text-to-image' as const] } : {}),
  };
}

/** Older servers accept only a URL for access checks; preset imports must check every effective file. */
export function checkpointAccessRequest(request: CheckpointImportRequest | LegacyCheckpointImportRequest): CheckpointImportRequest | { url: string } {
  return 'presetId' in request ? request : { url: request.url };
}

export function dependencyLabel(role: string): string {
  if (role === 'text-encoder') return 'Text encoder';
  if (role === 'vae') return 'VAE';
  if (role === 'diffusion-unconditional') return 'Unconditional weights';
  return role.replaceAll('-', ' ').replace(/^./, character => character.toUpperCase());
}
