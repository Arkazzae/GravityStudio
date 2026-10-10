'use client';

import { ArrowUp, LoaderCircle, X } from '@/components/ui/icons';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import type { GenerationTool, StudioModel } from '@/lib/api';
import { loraLimit, moveLoraChoice } from '@/lib/generation-draft';
import type { Draft } from './PromptDock';

const field = 'min-w-0 rounded-lg bg-chip px-2.5 py-2 text-[12px] text-ink outline-none ring-1 ring-transparent focus:ring-volt/40 disabled:opacity-50';

export function LoraOptions({ model, draft, tools, loading, error, busy, onChange, onReload, onManage }: { model?: StudioModel; draft: Draft; tools: GenerationTool[] | null; loading: boolean; error: string; busy: boolean; onChange: (change: Partial<Draft>) => void; onReload: () => void; onManage?: () => void }) {
  const family = model?.familyId;
  const chosen = draft.loras || [];
  const maximumLoras = loraLimit(model);
  const loraHelp = `${maximumLoras ? `Add up to ${maximumLoras} compatible LoRA${maximumLoras === 1 ? '' : 's'}. The assigned worker needs enough memory for the full stack. ` : 'This model does not support LoRAs. '}Strength 0 disables its effect, 1 uses its trained strength, and higher values intensify it. Include the author’s trigger words in your prompt when required.`;
  const loras = tools?.filter(tool => tool.kind === 'lora' && !!family && tool.familyIds.includes(family)) || [];

  return <div className="flex max-h-[min(60dvh,480px)] flex-col gap-2 overflow-y-auto px-1 [scrollbar-gutter:stable]">
    <div className="flex items-center justify-between gap-2 text-[12px] text-ink-2"><span>{chosen.length} of {maximumLoras} selected</span><HelpTooltip label="LoRA strength">{loraHelp}</HelpTooltip></div>
    {chosen.length > 1 && <p className="text-[11px] leading-5 text-ink-2">Applied from top to bottom. Changing the order can change the result.</p>}
    {!!chosen.length && <div role="list" aria-label="Selected LoRAs" className="flex flex-col gap-2">{chosen.map((choice, index) => {
      const tool = tools?.find(tool => tool.id === choice.id);
      const name = tool?.name || choice.id;
      return <div key={choice.id} role="listitem" className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={`${index + 1}. ${name}`}><span className="mr-1 text-ink-3">{index + 1}.</span>{name}</span>
        <input aria-label={`Strength for ${name}`} type="number" min={0} max={2} step={.05} className={`${field} w-16 text-right tabular-nums`} disabled={busy} value={Number.isFinite(choice.strength) ? choice.strength : ''} onChange={event => onChange({ loras: chosen.map(item => item.id === choice.id ? { ...item, strength: event.target.valueAsNumber } : item) })} />
        <button type="button" aria-label={`Move ${name} up`} title="Move LoRA up" disabled={busy || index === 0} onClick={() => onChange({ loras: moveLoraChoice(chosen, index, -1) })} className="grid size-7 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-white/[0.06] hover:text-ink disabled:opacity-35"><ArrowUp className="size-3.5" /></button>
        <button type="button" aria-label={`Move ${name} down`} title="Move LoRA down" disabled={busy || index === chosen.length - 1} onClick={() => onChange({ loras: moveLoraChoice(chosen, index, 1) })} className="grid size-7 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-white/[0.06] hover:text-ink disabled:opacity-35"><ArrowUp className="size-3.5 rotate-180" /></button>
        <button type="button" aria-label={`Remove ${name}`} disabled={busy} onClick={() => onChange({ loras: chosen.filter(item => item.id !== choice.id) })} className="grid size-8 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-white/[0.06] hover:text-ink disabled:opacity-50"><X className="size-4" /></button>
      </div>;
    })}</div>}
    {!maximumLoras ? <p className="text-[11px] leading-5 text-ink-2">This model does not support LoRAs.</p> : loading && !tools ? <p role="status" className="flex items-center gap-2 text-[11px] text-ink-2"><LoaderCircle className="size-3 animate-spin" />Checking model tools…</p> : loras.length ? <select aria-label="Add LoRA" value="" disabled={busy || chosen.length >= maximumLoras} className={field} onChange={event => { const id = event.target.value; if (id && chosen.length < maximumLoras && !chosen.some(choice => choice.id === id) && loras.some(tool => tool.id === id && tool.ready)) onChange({ loras: [...chosen, { id, strength: 1 }] }); }}>
      <option value="">Add a compatible LoRA…</option>{loras.filter(tool => !chosen.some(choice => choice.id === tool.id)).map(tool => <option key={tool.id} value={tool.id} disabled={!tool.ready}>{tool.name}{!tool.ready ? ' · Not ready' : ''}</option>)}
    </select> : <p className="text-[11px] leading-5 text-ink-2">No compatible LoRAs are installed for this model.</p>}
    {!!loras.length && !loras.some(tool => tool.ready) && <p className="text-[11px] leading-5 text-ink-2">{loras[0].missingReasons.join(' ') || 'Download a LoRA and connect a compatible worker.'}</p>}
    {error && <p role="alert" className="text-[11px] leading-5 text-[#ffc3aa]">{error}<button type="button" onClick={onReload} className="ml-2 underline">Try again</button></p>}
    {onManage && <button type="button" disabled={busy} onClick={onManage} className="min-h-9 text-left text-[12px] text-ink-2 underline underline-offset-3 hover:text-ink disabled:opacity-50">Manage model tools</button>}
  </div>;
}
