'use client';
import { useState } from 'react';
import { Check, Search, SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { Chip } from '@/components/ui/Chip';
import { Popover } from '@/components/ui/Popover';
import type { StudioModel } from '@/lib/api';

export function ModelMenu({ models, value, onChange, referenceCount }: { models: StudioModel[]; value: string; onChange: (id: string) => void; referenceCount: number }) {
  const [query, setQuery] = useState('');
  const selected = models.find(model => model.id === value);
  const visible = models.filter(model => `${model.name} ${model.family}`.toLowerCase().includes(query.toLowerCase()));
  const families = [...new Set(visible.map(model => model.family))];
  return <Popover label="Choose a model" width={360} flush initialFocus="input" trigger={({ open, triggerProps }) => <Chip {...triggerProps} active={open} chevron="right" className="max-w-[184px]" aria-label={`Model: ${selected?.name || 'Choose a model'}`}>{selected?.name || 'Choose a model'}</Chip>}>
    {close => <div className="p-1"><div className="flex items-center justify-between px-2 py-2 text-[13px] font-medium">Image models<Link href="/models" aria-label="Manage image models" className="text-ink-2 hover:text-ink"><SlidersHorizontal size={15} /></Link></div><label className="mb-2 flex h-9 items-center gap-2 rounded-[9px] border border-line-2 bg-panel-2 px-3 text-ink-2"><Search size={14} /><input aria-label="Search models" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models" className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none" /></label>
      <div className="max-h-[380px] overflow-y-auto">{families.map(family => <section key={family} className="border-t border-line py-1 first:border-0"><h3 className="px-2 py-2 text-xs text-ink-2">{family}</h3>{visible.filter(model => model.family === family).map(model => { const maxImages = model.capabilities?.maxImages ?? model.limits?.maxImages ?? 0; const incompatible = referenceCount > maxImages; return <button key={model.id} disabled={!model.ready || incompatible} onClick={() => { onChange(model.id); close(); }} className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-55"><div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{model.name}</p><p className="mt-1 text-[11px] leading-relaxed text-ink-2">{!model.ready ? model.unavailableReason || model.missingReasons?.[0] || 'Download this model from Models' : incompatible ? 'Remove reference images to use this model' : maxImages > 0 ? 'Text or image reference' : 'Text to image'}</p></div>{model.id === value && <Check className="size-4 shrink-0 text-volt" />}</button>; })}</section>)}{!visible.length && <p className="px-3 py-6 text-center text-sm text-ink-2">{models.length ? 'No models match your search.' : 'Download a model from Models to start creating.'}</p>}</div>
    </div>}
  </Popover>;
}
