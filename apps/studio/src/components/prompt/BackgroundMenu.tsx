'use client';
import { Background, RatioFrame, Wand2 } from '@/components/ui/icons';
import { Chip } from '@/components/ui/Chip';
import { Dropdown, MenuLabel, MenuOption } from '@/components/ui/Dropdown';
import { imageBackground, imageBackgroundLabels, imageBackgroundProblem } from '@/lib/image-background';
import { imageQualityProblem } from '@/lib/image-settings';
import type { ImageBackground, StudioModel } from '@/lib/api';
import type { Draft } from './PromptDock';

const options = [
  { id: 'auto', icon: Wand2, note: 'Use the model default' },
  { id: 'opaque', icon: RatioFrame, note: 'Keep a solid background' },
  { id: 'transparent', icon: Background },
] satisfies Array<{ id: ImageBackground; icon: typeof Background; note?: string }>;

export function BackgroundMenu({ model, draft, disabled = false, onChange }: { model?: StudioModel; draft: Draft; disabled?: boolean; onChange: (change: Partial<Draft>) => void }) {
  const selected = imageBackground(draft.background);
  const label = imageBackgroundLabels[selected];
  const unavailable = imageBackgroundProblem(model, 'transparent') || imageQualityProblem(model, draft.quality, 'transparent');
  return <Dropdown width={272} trigger={({ open, triggerProps }) => <Chip {...triggerProps} disabled={!model || disabled} active={open} title={`Background: ${label}`} aria-label={`Background: ${label}`} icon={<Background />} className="max-w-[156px]">{label}</Chip>}>
    {close => <><MenuLabel>Background</MenuLabel>{options.map(({ id, icon: Icon, note }) => <MenuOption key={id} active={selected === id} disabled={id === 'transparent' && !!unavailable}
      aria-label={`Background ${imageBackgroundLabels[id]}`} icon={<Icon />} label={imageBackgroundLabels[id]} noteClassName="text-ink-2"
      note={id === 'transparent' ? unavailable || (model?.capabilities?.background?.native ? 'Native transparency' : 'Remove background after generation') : note}
      onClick={() => { onChange({ background: id }); close(); }} />)}</>}
  </Dropdown>;
}
