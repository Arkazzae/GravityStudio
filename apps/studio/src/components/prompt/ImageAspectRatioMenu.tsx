'use client';
import { Scan } from 'lucide-react';
import { Chip } from '@/components/ui/Chip';
import { Dropdown, MenuLabel, MenuOption } from '@/components/ui/Dropdown';
import { IMAGE_ASPECT_RATIOS, imageAspectRatio, imageSizeForRatio, type ImageAspectRatio } from '@/lib/image-settings';
import type { StudioModel } from '@/lib/api';
import type { Draft } from './PromptDock';

function RatioIcon({ ratio }: { ratio: number | null }) {
  return <span className="grid size-[18px] shrink-0 place-items-center" aria-hidden="true">
    {ratio === null ? <Scan strokeWidth={1.7} /> : <span className="rounded-[2.5px] border-[1.5px] border-current" style={{ width: 16 * Math.min(1, ratio), height: 16 * Math.min(1, 1 / ratio) }} />}
  </span>;
}

export function ImageAspectRatioMenu({ model, draft, onChange }: { model?: StudioModel; draft: Draft; onChange: (size: { width: number; height: number; aspect: ImageAspectRatio }) => void }) {
  const selected = draft.aspect === 'auto' && draft.width === model?.defaults.width && draft.height === model?.defaults.height ? 'auto' : imageAspectRatio(draft.width, draft.height);
  const label = selected === 'auto' ? 'Auto' : selected === 'custom' ? `${draft.width} × ${draft.height}` : selected;
  return <Dropdown width={240} trigger={({ open, triggerProps }) => <Chip {...triggerProps} disabled={!model} active={open} title="Aspect ratio" aria-label={`Aspect ratio: ${label}`} icon={<RatioIcon ratio={selected === 'auto' ? null : draft.width / draft.height} />}>{label}</Chip>}>
    {close => <><MenuLabel>Aspect ratio</MenuLabel>{IMAGE_ASPECT_RATIOS.map(aspect => {
      const size = model ? imageSizeForRatio(model, aspect) : null;
      const [x, y] = aspect === 'auto' ? [0, 0] : aspect.split(':').map(Number);
      return <MenuOption key={aspect} active={selected === aspect} disabled={!size} aria-label={`Aspect ratio ${aspect === 'auto' ? 'Auto' : aspect}`} icon={<RatioIcon ratio={aspect === 'auto' ? null : x / y} />} label={aspect === 'auto' ? 'Auto' : aspect}
        note={size ? `${aspect === 'auto' ? 'Default · ' : ''}${size.width} × ${size.height}` : 'Not available for this model'}
        onClick={() => { if (size) onChange({ ...size, aspect }); close(); }} />;
    })}</>}
  </Dropdown>;
}
