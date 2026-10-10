'use client';
import { Gauge } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { Dropdown, MenuLabel, MenuNote, MenuOption } from '@/components/ui/Dropdown';
import { imageQualityForSize, imageQualityPresets, imageQualityProblem, imageSizeForQuality, ultraOutputSize, type ImageQuality } from '@/lib/image-settings';
import type { StudioModel } from '@/lib/api';
import type { Draft } from './PromptDock';
import { draftCanvasSize } from '@/lib/generation-draft';

const labels = { fast: 'Fast', standard: 'Standard', high: 'High', ultra: 'Ultra', custom: 'Custom' };

export function selectedQuality(model: StudioModel, draft: Draft): ImageQuality | 'custom' {
  if (draft.quality === 'ultra') return 'ultra';
  if (draft.quality === 'custom') return 'custom';
  if (draft.quality && draftCanvasSize(model, draft)) return draft.quality;
  if (draft.quality && imageQualityPresets(model).some(preset => preset.id === draft.quality)) {
    const size = imageSizeForQuality(model, draft.quality, draft.aspect || 'custom', draft);
    if (size?.width === draft.width && size.height === draft.height) return draft.quality;
  }
  return imageQualityForSize(model, draft.width, draft.height, draft.aspect || 'custom');
}

export function ImageQualityMenu({ model, draft, onChange }: { model?: StudioModel; draft: Draft; onChange: (change: Partial<Draft>) => void }) {
  const selected = model ? selectedQuality(model, draft) : 'standard';
  const label = labels[selected];
  const sourceCanvas = draftCanvasSize(model, draft);
  const ultraNative = sourceCanvas || (model ? imageSizeForQuality(model, 'ultra', draft.aspect || 'custom', draft) : null);
  const ultraSize = ultraNative ? ultraOutputSize(ultraNative.width, ultraNative.height) : null;
  const ultraSampling = model ? imageQualityPresets(model).find(preset => preset.id === 'high')?.sampling : undefined;
  const ultraProblem = !ultraNative ? 'Not available for this aspect ratio' : imageQualityProblem(model, 'ultra', draft.background);
  const selectedSize = selected === 'ultra' ? ultraSize : sourceCanvas || draft;
  return <Dropdown width={260} trigger={({ open, triggerProps }) => <Chip {...triggerProps} disabled={!model} active={open} title={`Quality: ${label}${selectedSize ? ` · ${selectedSize.width} × ${selectedSize.height}` : ''}${selected === 'ultra' ? ' · SeedVR2 7B' : ''}`} aria-label={`Quality: ${label}`} icon={<Gauge />}>{label}</Chip>}>
    {close => <><MenuLabel>Quality</MenuLabel>{model && imageQualityPresets(model).map(preset => {
      const size = sourceCanvas || imageSizeForQuality(model, preset.id, draft.aspect || 'custom', draft);
      const isDefault = !sourceCanvas && size?.width === model.defaults.width && size?.height === model.defaults.height;
      return <MenuOption key={preset.id} active={selected === preset.id} disabled={!size} aria-label={`Quality ${labels[preset.id]}`} icon={<Gauge />} label={labels[preset.id]} noteClassName="text-ink-2"
        note={size ? `${size.width} × ${size.height}${preset.sampling?.steps !== undefined ? ` · ${preset.sampling.steps} steps` : ''}${isDefault ? ' · Model default' : ''}` : 'Not available for this aspect ratio'}
        onClick={() => { if (size) onChange({ ...size, ...preset.sampling, quality: preset.id }); close(); }} />;
    })}{model && <MenuOption active={selected === 'ultra'} disabled={!!ultraProblem} aria-label="Quality Ultra" icon={<Gauge />} label="Ultra" noteClassName="text-ink-2"
      note={ultraProblem || (ultraSize ? `${ultraSize.width} × ${ultraSize.height} · High + SeedVR2 7B · 4K, 4096 px on the longest edge` : '')}
      onClick={() => { if (ultraNative) onChange({ ...ultraNative, ...ultraSampling, quality: 'ultra' }); close(); }} />}
      {selected === 'custom' && <MenuOption active disabled className="opacity-100" aria-label="Quality Custom" icon={<Gauge />} label="Custom" noteClassName="text-ink-2" note={`${draft.width} × ${draft.height}`} />}
      <MenuNote className="mt-1 border-t border-line pt-2 text-ink-2">{model?.qualityPresets?.some(preset => preset.sampling) ? 'Applies model sampling defaults. You can adjust them in Advanced. ' : 'Steps and guidance stay as set. '}Ultra upscales after generation and takes longer.</MenuNote>
    </>}
  </Dropdown>;
}
