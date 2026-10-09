'use client';
import { RotateCcw, Shuffle, SlidersHorizontal } from 'lucide-react';
import { IconChip } from '@/components/ui/Chip';
import { Popover } from '@/components/ui/Popover';
import type { StudioModel } from '@/lib/api';
import type { Draft } from './PromptDock';

function NumberControl({ label, min, max, step = 1, value, onChange }: { label: string; min: number; max: number; step?: number; value: number; onChange: (value: number) => void }) {
  return <div className="min-w-0 shrink-0 rounded-lg bg-white/[0.03] px-2.5 py-2">
    <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">{label}</span>
    <div className="flex min-w-0 items-center gap-2.5">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={Number.isFinite(value) ? value : min} onChange={event => onChange(event.target.valueAsNumber)} className="h-4 min-w-0 flex-1 cursor-pointer" />
      <input type="number" aria-label={`${label} value`} title={`${min} – ${max}`} min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} onChange={event => onChange(event.target.valueAsNumber)} className="h-7 w-[4.5rem] min-w-0 shrink-0 rounded-md bg-white/[0.05] px-2 text-right text-[12.5px] tabular-nums text-ink outline-none ring-1 ring-transparent transition focus:ring-volt/40" />
    </div>
  </div>;
}

export function DockSettings({ model, draft, busy, onChange, onReset }: { model?: StudioModel; draft: Draft; busy: boolean; onChange: (change: Partial<Draft>) => void; onReset: () => void }) {
  const dirty = !!model && (draft.width !== model.defaults.width || draft.height !== model.defaults.height || draft.steps !== model.defaults.steps || draft.cfg !== model.defaults.cfg || draft.negativePrompt !== (model.defaults.negativePrompt || '') || !!draft.seed.trim() || draft.denoise !== .75);
  const limits = model?.limits;
  const dimensions = model?.dimensions;
  const widthStep = limits?.width?.step ?? dimensions?.multiple ?? 16;
  const heightStep = limits?.height?.step ?? dimensions?.multiple ?? 16;
  const maxPixels = dimensions?.maxPixels ?? 2_097_152;
  const widthMax = Math.max(limits?.width?.min ?? dimensions?.min ?? 256, Math.min(limits?.width?.max ?? dimensions?.max ?? 2048, draft.height > 0 ? Math.floor(maxPixels / draft.height / widthStep) * widthStep : Infinity));
  const heightMax = Math.max(limits?.height?.min ?? dimensions?.min ?? 256, Math.min(limits?.height?.max ?? dimensions?.max ?? 2048, draft.width > 0 ? Math.floor(maxPixels / draft.width / heightStep) * heightStep : Infinity));
  const strength = !!draft.images.length && !model?.operations?.includes('reference');
  return <>
    <Popover label="Advanced settings" title="Advanced" width={320} align="end" trigger={({ open, triggerProps }) => <IconChip {...triggerProps} id="advanced-trigger" active={open} disabled={!model} aria-label="Advanced settings" title="Advanced settings"><SlidersHorizontal />{dirty && <span aria-hidden="true" className="absolute right-2 top-2 size-1.5 rounded-full bg-volt" />}</IconChip>}>
      {() => <div className="flex h-[min(60dvh,480px)] flex-col gap-1 overflow-y-auto [scrollbar-gutter:stable]">
        <NumberControl label="Width" min={limits?.width?.min ?? dimensions?.min ?? 256} max={widthMax} step={widthStep} value={draft.width} onChange={width => onChange({ width, aspect: 'custom' })} />
        <NumberControl label="Height" min={limits?.height?.min ?? dimensions?.min ?? 256} max={heightMax} step={heightStep} value={draft.height} onChange={height => onChange({ height, aspect: 'custom' })} />
        <NumberControl label="Steps" min={limits?.steps?.min ?? 1} max={limits?.steps?.max ?? 100} step={limits?.steps?.step ?? 1} value={draft.steps} onChange={steps => onChange({ steps })} />
        <NumberControl label="Guidance" min={limits?.cfg?.min ?? 0} max={limits?.cfg?.max ?? 30} step={limits?.cfg?.step ?? .1} value={draft.cfg} onChange={cfg => onChange({ cfg })} />
        <div className="min-w-0 shrink-0 rounded-lg bg-white/[0.03] px-2.5 py-2"><label htmlFor="generation-seed" className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Seed</label>
          <div className="flex gap-2"><input id="generation-seed" aria-label="Seed" type="number" inputMode="numeric" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.seed} onChange={event => onChange({ seed: event.target.value })} placeholder="Random" className="h-9 w-full min-w-0 rounded-lg bg-chip px-3 text-[13px] tabular-nums text-ink outline-none ring-1 ring-transparent transition placeholder:text-ink-3 focus:ring-volt/40" /><button type="button" aria-label="Randomise seed" title="Randomise seed" onClick={() => onChange({ seed: String(crypto.getRandomValues(new Uint32Array(1))[0]) })} className="grid size-9 shrink-0 place-items-center rounded-lg bg-chip text-ink-2 transition-colors hover:bg-chip-hi hover:text-ink"><Shuffle className="size-4" strokeWidth={1.8} /></button></div>
          <p className="mt-2 text-[11px] text-ink-3">Leave empty to let the server pick one.</p>
        </div>
        {strength && <NumberControl label="Image strength" min={.05} max={1} step={.05} value={draft.denoise} onChange={denoise => onChange({ denoise })} />}
        {model?.capabilities?.negativePrompt !== false && <label className="min-w-0 shrink-0 rounded-lg bg-white/[0.03] px-2.5 py-2"><span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">Negative prompt</span><textarea aria-label="Negative prompt" rows={3} maxLength={16000} value={draft.negativePrompt} onChange={event => onChange({ negativePrompt: event.target.value })} className="w-full resize-y rounded-lg bg-chip px-3 py-2 text-[13px] leading-6 text-ink outline-none ring-1 ring-transparent transition focus:ring-volt/40" /></label>}
      </div>}
    </Popover>
    <IconChip aria-label="Reset settings to defaults" title="Reset settings to defaults" disabled={!dirty || busy} onClick={onReset}><RotateCcw /></IconChip>
  </>;
}
