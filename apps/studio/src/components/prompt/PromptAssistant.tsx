'use client';

import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Chip } from '@/components/ui/Chip';
import { ArrowUp, LoaderCircle, RotateCcw, Wand2 } from '@/components/ui/icons';
import panel from '@/components/ui/Dropdown.module.css';
import { ApiError, api, errorMessage, type StudioModel } from '@/lib/api';
import type { RefinementResult, TextSettings } from '@/lib/text-api';
import { useAnchoredPopover } from '@/lib/useAnchoredPopover';
import { cn } from '@/lib/utils';
import type { Draft } from './PromptDock';

type Mode = 'refine' | 'rewrite';
interface Turn { id: number; instruction: string; prompt: string }
interface Undo { prompt: string; context: string }
interface Pending { controller: AbortController; context: string; identity: string; settingsRevision: number }
const modes: [Mode, string][] = [['refine', 'Refine'], ['rewrite', 'Rewrite']];
const small = 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-volt';
const primary = 'bg-volt text-on-volt transition-colors hover:bg-volt-hi disabled:cursor-not-allowed disabled:bg-white/[0.07] disabled:text-ink-3';
const draftContext = (draft: Draft) => JSON.stringify(draft);

export function PromptAssistant({ draft, setDraft, model, connected, submitting, sessionIdentity, onBusyChange, onSessionExpired, onOpenSettings }: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  model?: StudioModel;
  connected: boolean;
  submitting: boolean;
  sessionIdentity: string;
  onBusyChange: (busy: boolean) => void;
  onSessionExpired: () => void;
  onOpenSettings?: () => void;
}) {
  const { open, close, triggerProps, popoverProps } = useAnchoredPopover({ side: 'top', align: 'end', width: 360 });
  const [mode, setMode] = useState<Mode>('refine');
  const [settings, setSettings] = useState<TextSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [undo, setUndo] = useState<Undo | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const request = useRef<Pending | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const refine = useRef<HTMLButtonElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const turnId = useRef(0);
  const context = draftContext(draft);
  const latest = useRef({ context, sessionIdentity, onBusyChange, onSessionExpired });
  latest.current = { context, sessionIdentity, onBusyChange, onSessionExpired };
  const id = useId();
  const selection = settings?.assistant;
  const hasPrompt = !!draft.prompt.trim();
  const unavailable = !connected ? 'Reconnect to use the prompt assistant.'
    : !model ? 'Choose an image model first.'
    : loading ? 'Loading assistant settings…'
    : !selection ? 'Choose a language model in Assistant settings.' : '';
  const disabled = !!unavailable || submitting || busy;
  const canUndo = !!undo && undo.context === context && !busy && !submitting;

  useEffect(() => () => {
    request.current?.controller.abort();
    request.current = null;
    latest.current.onBusyChange(false);
  }, []);

  useEffect(() => {
    request.current?.controller.abort();
    request.current = null;
    setBusy(false); latest.current.onBusyChange(false);
    setSettings(null); setUndo(null); setTurns([]); setInstruction(''); setError('');
  }, [sessionIdentity]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void api<TextSettings>('/text/settings', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(value => { if (!controller.signal.aborted) setSettings(value); })
      .catch(failure => {
        if (controller.signal.aborted) return;
        setSettings(null); setError(errorMessage(failure));
        if (failure instanceof ApiError && failure.status === 401) latest.current.onSessionExpired();
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, reload, sessionIdentity]);

  useEffect(() => {
    if (undo && undo.context !== context) setUndo(null);
    if (request.current && (request.current.context !== context || settings && request.current.settingsRevision !== settings.revision)) {
      request.current.controller.abort(); request.current = null;
      setBusy(false); latest.current.onBusyChange(false);
      setError('Your prompt or image settings changed. Run the assistant again to use this draft.');
    }
  }, [context, undo, settings]);

  useEffect(() => { setTurns([]); setUndo(null); setInstruction(''); }, [draft.modelId]);
  useEffect(() => { if (open && document.activeElement?.getAttribute('role') !== 'tab') (mode === 'rewrite' ? input.current : refine.current)?.focus({ preventScroll: true }); }, [open, mode, loading]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [turns]);

  function cancel() {
    request.current?.controller.abort(); request.current = null;
    setBusy(false); onBusyChange(false);
  }

  function revert() {
    if (!canUndo || !undo) return;
    setDraft(current => draftContext(current) === undo.context ? { ...current, prompt: undo.prompt } : current);
    setUndo(null); setTurns([]); setError('');
  }

  async function write(command = '') {
    if (disabled || request.current || !model || !settings || !selection || !hasPrompt && !command.trim()) return;
    const pending = { controller: new AbortController(), context, identity: sessionIdentity, settingsRevision: settings.revision };
    request.current = pending;
    setBusy(true); onBusyChange(true); setError('');
    try {
      const result = await api<RefinementResult>('/prompts/refine', {
        method: 'POST',
        body: JSON.stringify({ prompt: draft.prompt, imageModelId: model.id, ...(command.trim() ? { instruction: command.trim() } : {}), settingsRevision: settings.revision }),
        signal: AbortSignal.any([pending.controller.signal, AbortSignal.timeout(selection.provider === 'local' ? 210_000 : 90_000)]),
      });
      if (pending.controller.signal.aborted || request.current !== pending || latest.current.sessionIdentity !== pending.identity) return;
      if (latest.current.context !== pending.context) throw new Error('Your prompt or image settings changed. Run the assistant again to use this draft.');
      if (!result || typeof result.prompt !== 'string' || !result.prompt.trim() || result.prompt.length > 16_000 || result.provider !== selection.provider || result.modelId !== selection.modelId) {
        throw new Error('The assistant could not finish this prompt. Your original text has been kept.');
      }
      setDraft(current => draftContext(current) === pending.context ? { ...current, prompt: result.prompt } : current);
      setUndo({ prompt: draft.prompt, context: draftContext({ ...draft, prompt: result.prompt }) });
      if (command.trim()) {
        setTurns(current => [...current.slice(-9), { id: ++turnId.current, instruction: command.trim(), prompt: result.prompt }]);
        setInstruction('');
      }
    } catch (failure) {
      if (pending.controller.signal.aborted || request.current !== pending) return;
      setError(errorMessage(failure));
      if (failure instanceof ApiError && failure.status === 401) onSessionExpired();
      if (failure instanceof ApiError && failure.status === 409) setReload(value => value + 1);
    } finally {
      if (request.current === pending) { request.current = null; setBusy(false); onBusyChange(false); }
    }
  }

  return <div className="relative shrink-0">
    <Chip {...triggerProps} aria-haspopup="dialog" aria-label="Open AI prompt assistant" title="Refine or rewrite your prompt" active={open}
      icon={busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" /> : <Wand2 className="text-volt" />}>AI</Chip>
    <div {...popoverProps} role="dialog" aria-label="AI prompt assistant" className={panel.menu}>
      <div className="flex min-h-9 items-center justify-between gap-2 p-1">
        <div role="tablist" aria-label="Assistant mode" className="flex rounded-lg bg-white/[0.04] p-0.5">
          {modes.map(([value, label], index) => <button key={value} type="button" role="tab" id={`${id}-${value}-tab`} aria-selected={mode === value} aria-controls={`${id}-${value}`} tabIndex={mode === value ? 0 : -1}
            onClick={() => setMode(value)} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + modes.length) % modes.length;
              setMode(modes[next][0]);
              document.getElementById(`${id}-${modes[next][0]}-tab`)?.focus();
            }}
            className={cn('h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-volt', mode === value ? 'bg-white/[0.1] text-ink' : 'text-ink-2 hover:text-ink')}>{label}</button>)}
        </div>
        {busy ? <div role="status" className="flex items-center gap-1 text-[11.5px] text-ink-2"><LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />Writing…<button type="button" onClick={cancel} className={small}>Cancel</button></div>
          : canUndo ? <button type="button" onClick={revert} className={small}><RotateCcw className="size-3.5" />Undo</button> : null}
      </div>

      <div role="tabpanel" id={`${id}-refine`} aria-labelledby={`${id}-refine-tab`} hidden={mode !== 'refine'} className="px-2 pb-2 pt-1">
        <p className="text-[12px] leading-5 text-ink-2">{hasPrompt ? `Clearer wording for ${model?.name ?? 'your image model'}. Review the result in your prompt before generating.` : 'Write a short idea first, or describe the image in Rewrite.'}</p>
        <button ref={refine} type="button" disabled={disabled || !hasPrompt} onClick={() => void write()} className={cn('mt-2.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-semibold', primary)}><Wand2 className="size-4" />Refine prompt</button>
      </div>

      <div role="tabpanel" id={`${id}-rewrite`} aria-labelledby={`${id}-rewrite-tab`} hidden={mode !== 'rewrite'} className="px-1 pb-1">
        {turns.length ? <ol ref={log} aria-label="Prompt changes" className="mb-2 flex max-h-52 flex-col gap-2.5 overflow-y-auto px-1 pt-1">
          {turns.map(turn => <li key={turn.id} className="flex flex-col gap-1">
            <p className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-white/[0.07] px-2.5 py-1.5 text-[12.5px] leading-5 text-ink">{turn.instruction}</p>
            <p title={turn.prompt} className="line-clamp-4 max-w-[92%] whitespace-pre-wrap break-words text-[12px] leading-5 text-ink-2">{turn.prompt}</p>
          </li>)}
        </ol> : <p className="px-1 pb-2 pt-1 text-[12px] leading-5 text-ink-2">{hasPrompt ? 'Tell the assistant what to change. Each instruction updates the current prompt.' : 'Describe the image and the assistant will write a prompt for you.'}</p>}
        <div className="flex items-end gap-1.5 rounded-lg bg-white/[0.04] p-1 pl-2.5">
          <textarea ref={input} aria-label="Rewrite instruction" value={instruction} maxLength={2000} rows={2} disabled={busy || submitting} onChange={event => setInstruction(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void write(instruction); } }}
            placeholder={hasPrompt ? 'Make it an evening scene…' : 'A ceramic teapot in a sunlit kitchen…'}
            className="max-h-28 min-h-10 min-w-0 flex-1 resize-y bg-transparent py-1 text-[12.5px] leading-5 text-ink outline-none placeholder:text-ink-2 disabled:opacity-60" />
          <button type="button" aria-label="Rewrite prompt" disabled={disabled || !instruction.trim()} onClick={() => void write(instruction)} className={cn('grid size-8 shrink-0 place-items-center rounded-md', primary)}><ArrowUp className="size-4" /></button>
        </div>
        {turns.length ? <button type="button" className={cn(small, 'mt-1')} onClick={() => setTurns([])}>Clear history</button> : null}
      </div>

      {error ? <p role="alert" className="px-2 pb-1.5 pt-1 text-[11.5px] leading-5 text-[#ffc3aa]">{error}</p> : null}
      <div className="mt-1 border-t border-white/[0.06] px-2 pb-1 pt-2">
        {unavailable ? <p role="status" className="text-[11.5px] leading-5 text-ink-2">{unavailable}</p>
          : <p title={selection?.modelId} className="truncate text-[11.5px] leading-5 text-ink-2">{selection?.provider === 'local' ? 'Local Studio' : selection?.provider === 'gemini' ? 'Gemini' : 'Custom endpoint'} · {selection?.modelId}</p>}
        {onOpenSettings ? <button type="button" disabled={busy} onClick={() => { close(); onOpenSettings(); }} className={cn(small, '-ml-1.5 mt-0.5 disabled:opacity-50')}>{selection ? 'Assistant settings' : 'Choose assistant model'}</button> : null}
      </div>
    </div>
  </div>;
}
