'use client';

import { Switch } from '@/components/ui/Switch';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import type { StudioModel } from '@/lib/api';
import { generationOperation, ideogramModel, initialStructuredPrompt, promptFields, structuredPromptProblem } from '@/lib/generation-draft';
import type { Draft } from './PromptDock';

const field = 'min-w-0 rounded-lg bg-chip px-2.5 py-2 text-[12px] text-ink outline-none ring-1 ring-transparent focus:ring-volt/40 disabled:opacity-50';

export function GenerationOptions({ model, draft, busy, onChange, onManage, onEditSource }: { model?: StudioModel; draft: Draft; busy: boolean; onChange: (change: Partial<Draft>) => void; onManage?: () => void; onEditSource?: () => void }) {
  const family = model?.familyId;
  const operation = generationOperation(model, draft);
  const reference = model?.capabilities?.editing?.reference;
  const refiner = model?.capabilities?.editing?.refiner;
  const captionError = structuredPromptProblem(model, draft);
  return <>
    {!!draft.images.length && <section className="mt-2 flex shrink-0 flex-col gap-2 border-t border-line px-1 pt-3">
      <h3 className="text-[12px] font-medium">Image input</h3>
      {(model?.operations?.includes('image-to-image') && model.operations.includes('reference')) && <div className="flex flex-col gap-1.5 text-[11px] text-ink-2"><span className="flex items-center gap-1">Mode<HelpTooltip label="Image input mode">Image to image redraws the source using Image strength. Reference uses it to guide a new composition.</HelpTooltip></span><select aria-label="Image input mode" className={field} disabled={busy || !!draft.mask || !!draft.outpaint} value={operation} onChange={event => onChange({ imageMode: event.target.value as Draft['imageMode'] })}>
        <option value="image-to-image">Image to image</option><option value="reference" disabled={reference?.available === false}>Reference{reference?.experimental ? ' · Experimental' : ''}</option>
      </select></div>}
      {operation === 'reference' && <><p className="text-[11px] leading-5 text-ink-2">{reference?.available === false ? reference.reason : reference?.experimental ? 'Experimental reference conditioning. Ideogram uses a 1024 × 1024 output canvas.' : 'Guide the new image using the selected references.'}</p>
        {['sdxl', 'krea-2'].includes(family || '') && <div className="flex flex-col gap-1 text-[11px] text-ink-2"><span className="flex items-center gap-1">Reference strength<HelpTooltip label="Reference strength">Controls how strongly the reference influences the new image. Start at 1; larger values can reduce freedom or introduce artifacts.</HelpTooltip></span><input aria-label="Reference strength" type="number" min={0} max={2} step={.05} disabled={busy} className={field} value={Number.isFinite(draft.referenceStrength ?? 1) ? draft.referenceStrength ?? 1 : ''} onChange={event => onChange({ referenceStrength: event.target.valueAsNumber })} /></div>}</>}
      {(draft.mask || draft.outpaint) && <p className="text-[11px] leading-5 text-ink-2">{draft.mask ? 'A painted mask selects the area to edit.' : 'The source canvas will be extended.'} Clear edits in the source editor to change mode.</p>}
      {onEditSource && <button type="button" disabled={busy} onClick={onEditSource} className="min-h-9 text-left text-[12px] text-ink-2 underline underline-offset-3 hover:text-ink disabled:opacity-50">Edit source canvas</button>}
    </section>}
    {(family === 'sdxl' || draft.refiner) && <section className="mt-2 flex shrink-0 flex-col gap-2 border-t border-line px-1 pt-3"><div className="flex items-center justify-between gap-3"><span className="flex items-center gap-1 text-[12px] text-ink">SDXL refiner<HelpTooltip label="SDXL refiner">Hand the final denoising steps to the SDXL refiner. It can improve fine details and requires additional model memory.</HelpTooltip></span><Switch label="Use SDXL refiner" checked={!!draft.refiner} disabled={busy || !refiner?.available && !draft.refiner} onChange={refiner => onChange({ refiner })} /></div><p className="text-[11px] leading-5 text-ink-2">{refiner?.available ? 'Finish the image with the installed SDXL refiner.' : refiner?.reason || 'Download the refiner in Models → Tools and connect a compatible worker.'}</p>
      {onManage && <button type="button" disabled={busy} onClick={onManage} className="min-h-9 text-left text-[12px] text-ink-2 underline underline-offset-3 hover:text-ink disabled:opacity-50">Manage model tools</button>}
    </section>}
    {ideogramModel(model) && <details className="mt-2 shrink-0 border-t border-line px-1 pt-3">
      <summary className="cursor-pointer text-[12px] font-medium">Structured prompt{draft.structuredPrompt ? ' · Enabled' : ''}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-1 text-[11px] text-ink-2">Use an Ideogram caption<HelpTooltip label="Structured prompt">Send a native JSON caption with object placement, exact text and visual attributes. Editing the main prompt returns to plain text; the AI assistant can create a new caption.</HelpTooltip></span><Switch label="Use structured prompt" checked={draft.structuredPrompt !== undefined} disabled={busy} onChange={enabled => onChange({ structuredPrompt: enabled ? initialStructuredPrompt(draft.prompt) : undefined })} /></div>
        <p className="text-[11px] leading-5 text-ink-2">The scene description stays in your prompt. Edit the full caption here to set object descriptions, text and bounding boxes.</p>
        {draft.structuredPrompt !== undefined && <textarea aria-label="Ideogram structured prompt" spellCheck={false} rows={9} maxLength={16000} disabled={busy} value={draft.structuredPrompt} className={`${field} w-full resize-y leading-5`} onChange={event => { const structuredPrompt = event.target.value; let prompt = draft.prompt; try { const parsed = promptFields(structuredPrompt, model!); if (parsed.structuredPrompt) prompt = parsed.prompt; } catch { /* Preserve partial JSON while the user edits. */ } onChange({ structuredPrompt, prompt }); }} />}
        {captionError && <p role="alert" className="text-[11px] leading-5 text-[#ffc3aa]">{captionError}</p>}
      </div>
    </details>}
  </>;
}
