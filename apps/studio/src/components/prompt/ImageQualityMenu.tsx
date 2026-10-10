'use client';
import { Gauge } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { Dropdown, MenuLabel, MenuNote, MenuOption } from '@/components/ui/Dropdown';
import { imageQualityForSize, imageQualityPresets, imageSizeForQuality, type ImageQuality } from '@/lib/image-settings';
import type { StudioModel } from '@/lib/api';
import type { Draft } from './PromptDock';

const labels = { fast: 'Fast', standard: 'Standard', high: 'High', custom: 'Custom' };

export function selectedQuality(model: StudioModel, draft: Draft): ImageQuality | 'custom' {
  if (draft.quality === 'custom') return 'custom';
  if (draft.quality && imageQualityPresets(model).some(preset => preset.id === draft.quality)) {
    const size = imageSizeForQuality(model, draft.quality, draft.aspect || 'custom', draft);
    if (size?.width === draft.width && size.height === draft.height) return draft.quality;
  }
  return imageQualityForSize(model, draft.width, draft.height, draft.aspect || 'custom');
}

export function ImageQualityMenu({ model, draft, onChange }: { model?: StudioModel; draft: Draft; onChange: (change: Partial<Draft>) => void }) {
  const selected = model ? selectedQuality(model, draft) : 'standard';
  const label = labels[selected];
  return <Dropdown width={260} trigger={({ open, triggerProps }) => <Chip {...triggerProps} disabled={!model} active={open} title={`Quality: ${label} · ${draft.width} × ${draft.height}`} aria-label={`Quality: ${label}`} icon={<Gauge />}>{label}</Chip>}>
    {close => <><MenuLabel>Quality</MenuLabel>{model && imageQualityPresets(model).map(preset => {
      const size = imageSizeForQuality(model, preset.id, draft.aspect || 'custom', draft);
      const isDefault = size?.width === model.defaults.width && size?.height === model.defaults.height;
      return <MenuOption key={preset.id} active={selected === preset.id} disabled={!size} aria-label={`Quality ${labels[preset.id]}`} icon={<Gauge />} label={labels[preset.id]}
        note={size ? `${size.width} × ${size.height}${isDefault ? ' · Model default' : ''}` : 'Not available for this aspect ratio'}
        onClick={() => { if (size) onChange({ ...size, quality: preset.id }); close(); }} />;
    })}{selected === 'custom' && <MenuOption active disabled aria-label="Quality Custom" icon={<Gauge />} label="Custom" note={`${draft.width} × ${draft.height}`} />}
      <MenuNote className="mt-1 border-t border-line pt-2 text-ink-2">Changes resolution. Steps and guidance stay as set.</MenuNote>
    </>}
  </Dropdown>;
}
