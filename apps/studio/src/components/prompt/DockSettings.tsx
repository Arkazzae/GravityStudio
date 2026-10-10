'use client';
import { RotateCcw, Shuffle, SlidersHorizontal } from '@/components/ui/icons';
import { IconChip } from '@/components/ui/Chip';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import { Popover } from '@/components/ui/Popover';
import type { GenerationTool, StudioModel } from '@/lib/api';
import { draftCanvasSize, generationOperation, ideogramModel } from '@/lib/generation-draft';
import { imageQualityForSize, imageQualitySampling } from '@/lib/image-settings';
import { GenerationOptions } from './GenerationOptions';
import type { Draft } from './PromptDock';

const parameterHelp = {
  Width: 'Output width in pixels. Larger images use more memory and can take longer.',
  Height: 'Output height in pixels. Larger images use more memory and can take longer.',
  Steps: 'Denoising passes used to create the image. More steps take longer and do not always improve quality.',
  Guidance: 'How strongly the model follows your prompt. At 1, the negative prompt has no effect. Higher values can reduce variety or introduce artifacts.',
  Seed: 'Controls the starting noise. Reuse it with the same model and settings for similar results, or leave it empty for a random seed.',
  'Image strength': 'How much to change the reference image. Lower values preserve more of the original; higher values redraw more.',
  'Negative prompt': 'Things you want the model to avoid, such as blur or unwanted details.',
};

function ParameterLabel({ label, htmlFor }: { label: keyof typeof parameterHelp; htmlFor?: string }) {
  return <div className="relative mb-1 pr-6 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
    {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
    <HelpTooltip label={label} className="absolute -right-1 top-1/2 -translate-y-1/2">{parameterHelp[label]}</HelpTooltip>
  </div>;
}

function NumberControl({ label, min, max, step = 1, value, disabled = false, onChange }: { label: keyof typeof parameterHelp; min: number; max: number; step?: number; value: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <div className="min-w-0 shrink-0 rounded-lg bg-white/[0.03] px-2.5 py-2">
    <ParameterLabel label={label} />
    <div className="flex min-w-0 items-center gap-2.5">
      <input type="range" aria-label={label} min={min} max={max} step={step} disabled={disabled} value={Number.isFinite(value) ? value : min} onChange={event => onChange(event.target.valueAsNumber)} className="h-4 min-w-0 flex-1 cursor-pointer disabled:opacity-50" />
      <input type="number" aria-label={`${label} value`} title={`${min} – ${max}`} min={min} max={max} step={step} disabled={disabled} value={Number.isFinite(value) ? value : ''} onChange={event => onChange(event.target.valueAsNumber)} className="h-7 w-[4.5rem] min-w-0 shrink-0 rounded-md bg-white/[0.05] px-2 text-right text-[12.5px] tabular-nums text-ink outline-none ring-1 ring-transparent transition focus:ring-volt/40 disabled:opacity-50" />
    </div>
  </div>;
}

export function DockSettings({ model, draft, busy, tools, toolsLoading, toolsError, onReloadTools, onManageTools, onEditSource, onChange, onReset }: { model?: StudioModel; draft: Draft; busy: boolean; tools: GenerationTool[] | null; toolsLoading: boolean; toolsError: string; onReloadTools: () => void; onManageTools?: () => void; onEditSource?: () => void; onChange: (change: Partial<Draft>) => void; onReset: () => void }) {
  const defaults = model ? { ...model.defaults, ...imageQualitySampling(model, imageQualityForSize(model, model.defaults.width, model.defaults.height, 'auto')) } : null;
  const dirty = !!defaults && (draft.quality === 'ultra' || draft.width !== defaults.width || draft.height !== defaults.height || draft.steps !== defaults.steps || draft.cfg !== defaults.cfg || draft.negativePrompt !== (defaults.negativePrompt || '') || !!draft.seed.trim() || draft.denoise !== .75 || (draft.background || 'auto') !== 'auto' || !!draft.mask || !!draft.outpaint || !!draft.matchSource || !!draft.refiner || !!draft.loras?.length || !!draft.structuredPrompt || !!draft.imageMode || draft.referenceStrength !== undefined && draft.referenceStrength !== 1);
  const sourceCanvas = draftCanvasSize(model, draft);
  const limits = model?.limits;
  const dimensions = model?.dimensions;
  const widthStep = limits?.width?.step ?? dimensions?.multiple ?? 16;
  const heightStep = limits?.height?.step ?? dimensions?.multiple ?? 16;
  const maxPixels = dimensions?.maxPixels ?? 2_097_152;
  const widthMax = Math.max(limits?.width?.min ?? dimensions?.min ?? 256, Math.min(limits?.width?.max ?? dimensions?.max ?? 2048, draft.height > 0 ? Math.floor(maxPixels / draft.height / widthStep) * widthStep : Infinity));
  const heightMax = Math.max(limits?.height?.min ?? dimensions?.min ?? 256, Math.min(limits?.height?.max ?? dimensions?.max ?? 2048, draft.width > 0 ? Math.floor(maxPixels / draft.width / heightStep) * heightStep : Infinity));
  const strength = generationOperation(model, draft) === 'image-to-image';
  return <>
    <Popover label="Advanced settings" title="Advanced" width={320} align="end" trigger={({ open, triggerProps }) => <IconChip {...triggerProps} id="advanced-trigger" active={open} disabled={!model} onClick={() => { if (!open) onReloadTools(); }} aria-label="Advanced settings" title="Advanced settings"><SlidersHorizontal />{dirty && <span aria-hidden="true" className="absolute right-2 top-2 size-1.5 rounded-full bg-volt" />}</IconChip>}>
      {close => <div className="flex h-[min(60dvh,480px)] flex-col gap-1 overflow-y-auto [scrollbar-gutter:stable]">
        <NumberControl label="Width" min={limits?.width?.min ?? dimensions?.min ?? 256} max={widthMax} step={widthStep} disabled={!!sourceCanvas} value={sourceCanvas?.width ?? draft.width} onChange={width => onChange({ width, aspect: 'custom', quality: 'custom' })} />
        <NumberControl label="Height" min={limits?.height?.min ?? dimensions?.min ?? 256} max={heightMax} step={heightStep} disabled={!!sourceCanvas} value={sourceCanvas?.height ?? draft.height} onChange={height => onChange({ height, aspect: 'custom', quality: 'custom' })} />
        {sourceCanvas && <p className="px-1 py-1 text-[11px] leading-5 text-ink-2">{ideogramModel(model) && generationOperation(model, draft) === 'reference' ? 'Ideogram reference mode uses a fixed 1024 × 1024 canvas.' : 'Dimensions follow the source canvas. Adjust its padding in the source editor.'}</p>}
        <NumberControl label="Steps" min={limits?.steps?.min ?? 1} max={limits?.steps?.max ?? 100} step={limits?.steps?.step ?? 1} value={draft.steps} onChange={steps => onChange({ steps })} />
        <NumberControl label="Guidance" min={limits?.cfg?.min ?? 0} max={limits?.cfg?.max ?? 30} step={limits?.cfg?.step ?? .1} value={draft.cfg} onChange={cfg => onChange({ cfg })} />
        <div className="min-w-0 shrink-0 rounded-lg bg-white/[0.03] px-2.5 py-2"><ParameterLabel label="Seed" htmlFor="generation-seed" />
          <div className="flex gap-2"><input id="generation-seed" aria-label="Seed" type="number" inputMode="numeric" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.seed} onChange={event => onChange({ seed: event.target.value })} placeholder="Random" className="h-9 w-full min-w-0 rounded-lg bg-chip px-3 text-[13px] tabular-nums text-ink outline-none ring-1 ring-transparent transition placeholder:text-ink-3 focus:ring-volt/40" /><button type="button" aria-label="Randomise seed" title="Randomise seed" onClick={() => onChange({ seed: String(crypto.getRandomValues(new Uint32Array(1))[0]) })} className="grid size-9 shrink-0 place-items-center rounded-lg bg-chip text-ink-2 transition-colors hover:bg-chip-hi hover:text-ink"><Shuffle className="size-4" strokeWidth={1.8} /></button></div>
          <p className="mt-2 text-[11px] text-ink-3">Leave empty to let the server pick one.</p>
        </div>
        {strength && <NumberControl label="Image strength" min={.05} max={1} step={.05} value={draft.denoise} onChange={denoise => onChange({ denoise })} />}
        {model?.capabilities?.negativePrompt !== false && <div className="min-w-0 shrink-0 rounded-lg bg-white/[0.03] px-2.5 py-2"><ParameterLabel label="Negative prompt" /><textarea aria-label="Negative prompt" rows={3} maxLength={16000} value={draft.negativePrompt} onChange={event => onChange({ negativePrompt: event.target.value })} className="w-full resize-y rounded-lg bg-chip px-3 py-2 text-[13px] leading-6 text-ink outline-none ring-1 ring-transparent transition focus:ring-volt/40" /></div>}
        <GenerationOptions model={model} draft={draft} busy={busy} tools={tools} loading={toolsLoading} error={toolsError} onReload={onReloadTools} onChange={onChange} onManage={onManageTools ? () => { close(); onManageTools(); } : undefined} onEditSource={onEditSource ? () => { close(); onEditSource(); } : undefined} />
      </div>}
    </Popover>
    <IconChip aria-label="Reset settings to defaults" title="Reset settings to defaults" disabled={!dirty || busy} onClick={onReset}><RotateCcw /></IconChip>
  </>;
}
