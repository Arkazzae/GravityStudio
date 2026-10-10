'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { Background, ImageIcon, RotateCcw, X } from '@/components/ui/icons';
import { api, ApiError, errorMessage, type InputImage, type OutpaintPadding, type StudioModel } from '@/lib/api';
import { maskDimensionsValid, maskPoint, maskRgba, rasterizeMask, MAX_MASK_POINTS, MAX_MASK_STROKES, type MaskPoint, type MaskStroke } from '@/lib/image-mask';
import { useRetainedDialog } from '@/lib/use-retained-dialog';
import { sourceCanvasSize } from '../../../../../packages/contracts/image-size';
import dialogStyles from '../studio/StudioDialog.module.css';
import styles from './ReferenceEditor.module.css';

export interface ReferenceEditValue { mask?: InputImage; outpaint?: OutpaintPadding; matchSource?: boolean }
type Mode = 'canvas' | 'mask' | 'extend';
const modes: Mode[] = ['canvas', 'mask', 'extend'];
const emptyPadding: OutpaintPadding = { left: 0, right: 0, top: 0, bottom: 0 };

function loadMask(url: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); image.src = ''; reject(new DOMException('Mask loading cancelled.', 'AbortError')); };
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error('The saved mask could not be loaded. Reset it or try again.')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else image.src = url;
  });
}

function paintPreview(context: CanvasRenderingContext2D, stroke: MaskStroke, scaleX: number, scaleY: number) {
  context.save(); context.scale(scaleX, scaleY);
  context.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  context.strokeStyle = '#B3EF69'; context.fillStyle = '#B3EF69'; context.lineWidth = stroke.radius * 2; context.lineCap = 'round'; context.lineJoin = 'round';
  context.beginPath(); context.arc(stroke.points[0].x, stroke.points[0].y, stroke.radius, 0, Math.PI * 2); context.fill();
  context.beginPath(); context.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
  context.stroke(); context.restore();
}

export function ReferenceEditor({ open, image, model, value, operation, missingMask = false, onApply, onClose, onSessionExpired, onBusyChange }: {
  open: boolean; image: InputImage; model: StudioModel; value: ReferenceEditValue;
  operation?: 'text-to-image' | 'image-to-image' | 'reference';
  missingMask?: boolean;
  onApply: (value: ReferenceEditValue) => void; onClose: () => void; onSessionExpired: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), closeButton = useRef<HTMLButtonElement>(null), preview = useRef<HTMLCanvasElement>(null);
  const lifecycle = useRef<AbortController | null>(null), upload = useRef<AbortController | null>(null);
  const savedMask = useRef<HTMLImageElement | null>(null), drawing = useRef<{ pointer: number; stroke: MaskStroke } | null>(null);
  const history = useRef<MaskStroke[]>([]), callbacks = useRef({ onBusyChange, onApply, onClose, onSessionExpired });
  callbacks.current = { onBusyChange, onApply, onClose, onSessionExpired };
  const [mode, setMode] = useState<Mode>(value.mask || missingMask ? 'mask' : value.outpaint ? 'extend' : 'canvas');
  const [match, setMatch] = useState(!!value.matchSource), [padding, setPadding] = useState<OutpaintPadding>(value.outpaint ?? emptyPadding);
  const [brush, setBrush] = useState(Math.min(Math.max(image.width, image.height), Math.max(8, Math.min(96, Math.round(Math.min(image.width, image.height) / 12)))));
  const [erase, setErase] = useState(false), [version, setVersion] = useState(0), [resetMask, setResetMask] = useState(false);
  const [busy, setBusy] = useState(false), [maskLoaded, setMaskLoaded] = useState(!value.mask), [error, setError] = useState('');
  const [sourceFailed, setSourceFailed] = useState(false), [cursor, setCursor] = useState<MaskPoint | null>(null);
  const editing = model.capabilities?.editing;
  const experimentalReference = model.familyId === 'ideogram-4' && operation === 'reference';
  const specialReason = experimentalReference ? 'Switch from experimental reference to image-to-image to edit the canvas.' : '';
  const maskReason = specialReason || (!editing?.inpaint.available ? editing?.inpaint.reason || 'Mask editing is unavailable for this model.' : !maskDimensionsValid(image.width, image.height) ? 'For mask painting, resize the source to at most 4096 × 4096 pixels (16 MP), or an equivalent area.' : '');
  const extendReason = specialReason || (!editing?.outpaint.available ? editing?.outpaint.reason || 'Canvas extension is unavailable for this model.' : '');
  const matchReason = specialReason || (!editing?.matchSource.available ? editing?.matchSource.reason || 'Matching the source canvas is unavailable for this model.' : '');
  const fitted = sourceCanvasSize(model, image, mode === 'extend' ? padding : undefined);
  const hasPadding = Object.values(padding).some(side => side > 0);
  const display = mode === 'extend' && fitted ? fitted : { width: image.width, height: image.height, sourceWidth: image.width, sourceHeight: image.height };
  const maskDirty = resetMask || history.current.length > 0;
  const unavailable = mode === 'mask' ? maskReason : mode === 'extend' ? extendReason : match ? matchReason : '';
  const applyDisabled = busy || !!unavailable || sourceFailed || (mode !== 'canvas' || match) && !fitted || mode === 'mask' && (!maskLoaded || !maskDirty && !value.mask) || mode === 'extend' && !hasPadding;
  const dialogEvents = useRetainedDialog({ dialog, open, onClose, initialFocus: closeButton, dismissible: !busy });

  useEffect(() => {
    if (!open) { setBusy(false); return; }
    const controller = new AbortController(); lifecycle.current = controller;
    return () => { controller.abort(); upload.current?.abort(); drawing.current = null; callbacks.current.onBusyChange?.(false); };
  }, [open]);

  useEffect(() => {
    if (!open || !value.mask || resetMask || maskReason) return;
    const controller = new AbortController(); setMaskLoaded(false);
    void loadMask(value.mask.url, controller.signal).then(loaded => {
      if (controller.signal.aborted) return;
      if (loaded.naturalWidth !== image.width || loaded.naturalHeight !== image.height) throw new Error('The saved mask does not match the source dimensions. Reset it to paint a new mask.');
      savedMask.current = loaded; setMaskLoaded(true); setVersion(version => version + 1);
    }).catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [open, value.mask?.url, image.width, image.height, resetMask, maskReason]);

  function redraw() {
    const canvas = preview.current, context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (savedMask.current && !resetMask) {
      context.drawImage(savedMask.current, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < data.data.length; index += 4) {
        const selected = data.data[index] >= 128;
        data.data[index] = 179; data.data[index + 1] = 239; data.data[index + 2] = 105; data.data[index + 3] = selected ? 255 : 0;
      }
      context.putImageData(data, 0, 0);
    }
    for (const stroke of history.current) paintPreview(context, stroke, canvas.width / image.width, canvas.height / image.height);
  }
  useEffect(() => { redraw(); }, [version, open, mode, resetMask, image.width, image.height]);

  function finishStroke(cancel = false) {
    const active = drawing.current; drawing.current = null;
    if (!active) return;
    if (!cancel) history.current = [...history.current, active.stroke];
    setVersion(version => version + 1);
  }

  function startStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (busy || maskReason || !maskLoaded || event.button !== 0 || drawing.current) return;
    if (history.current.length >= MAX_MASK_STROKES || history.current.reduce((sum, stroke) => sum + stroke.points.length, 0) >= MAX_MASK_POINTS) { setError('The mask history is full. Undo a stroke or reset the mask to continue.'); return; }
    const point = maskPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), image.width, image.height);
    if (!point) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = { points: [point], radius: brush / 2, erase };
    drawing.current = { pointer: event.pointerId, stroke }; setError('');
    const context = event.currentTarget.getContext('2d');
    if (context) paintPreview(context, stroke, event.currentTarget.width / image.width, event.currentTarget.height / image.height);
  }

  function moveStroke(event: PointerEvent<HTMLCanvasElement>) {
    const active = drawing.current;
    if (!active || active.pointer !== event.pointerId) return;
    const point = maskPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), image.width, image.height);
    if (!point) return;
    const previous = active.stroke.points.at(-1)!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < Math.max(1, brush / 12)) return;
    if (history.current.reduce((sum, stroke) => sum + stroke.points.length, active.stroke.points.length) >= MAX_MASK_POINTS) { finishStroke(); setError('The mask history is full. Undo a stroke or reset the mask to continue.'); return; }
    active.stroke.points.push(point);
    const context = event.currentTarget.getContext('2d');
    if (context) paintPreview(context, { ...active.stroke, points: [previous, point] }, event.currentTarget.width / image.width, event.currentTarget.height / image.height);
  }

  function reset() { drawing.current = null; history.current = []; savedMask.current = null; setResetMask(true); setMaskLoaded(true); setError(''); setVersion(version => version + 1); }
  function undo() { drawing.current = null; history.current = history.current.slice(0, -1); setError(''); setVersion(version => version + 1); }

  async function maskBlob(signal: AbortSignal): Promise<Blob> {
    signal.throwIfAborted();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Mask editing is unavailable in this browser.');
      let base: Uint8Array | undefined;
      if (savedMask.current && !resetMask) {
        context.drawImage(savedMask.current, 0, 0); base = new Uint8Array(image.width * image.height);
        for (let y = 0; y < image.height; y += 64) {
          const data = context.getImageData(0, y, image.width, Math.min(64, image.height - y));
          for (let index = 0; index < data.data.length; index += 4) base[y * image.width + index / 4] = data.data[index];
        }
      }
      const pixels = rasterizeMask(image.width, image.height, history.current, base);
      if (!pixels.some(value => value > 0)) throw new Error('Paint at least one area to change, or use Clear edits.');
      for (let y = 0; y < image.height; y += 64) {
        const rows = Math.min(64, image.height - y);
        context.putImageData(new ImageData(maskRgba(pixels, y * image.width, rows * image.width), image.width, rows), 0, y);
      }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The mask could not be saved. Try again.')), 'image/png'));
      signal.throwIfAborted(); return blob;
    } finally { canvas.width = 0; canvas.height = 0; }
  }

  async function apply() {
    if (applyDisabled || upload.current) return;
    const controller = new AbortController(); upload.current = controller;
    const activeLifecycle = lifecycle.current;
    const signal = AbortSignal.any([controller.signal, activeLifecycle?.signal ?? AbortSignal.abort(), AbortSignal.timeout(45_000)]);
    setBusy(true); callbacks.current.onBusyChange?.(true); setError('');
    try {
      let result: ReferenceEditValue;
      if (mode === 'mask') {
        const mask = !maskDirty && value.mask ? value.mask : await api<InputImage>('/inputs', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('edit-mask.png') }, body: await maskBlob(signal), signal });
        result = { mask, matchSource: true };
      } else if (mode === 'extend') result = { outpaint: { ...padding }, matchSource: true };
      else result = match ? { matchSource: true } : {};
      signal.throwIfAborted(); callbacks.current.onApply(result); callbacks.current.onClose();
    } catch (reason) {
      if (activeLifecycle?.signal.aborted || controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) callbacks.current.onSessionExpired();
      else setError(signal.aborted ? 'Saving the mask timed out. Try again.' : errorMessage(reason));
    } finally {
      if (upload.current === controller) upload.current = null;
      if (lifecycle.current === activeLifecycle && !activeLifecycle?.signal.aborted) { setBusy(false); callbacks.current.onBusyChange?.(false); }
    }
  }

  const previewScale = Math.min(1, 1024 / Math.max(image.width, image.height));
  const imageStyle: CSSProperties = mode === 'extend' && fitted ? { left: `${padding.left / display.width * 100}%`, top: `${padding.top / display.height * 100}%`, width: `${display.sourceWidth / display.width * 100}%`, height: `${display.sourceHeight / display.height * 100}%` } : { inset: 0, width: '100%', height: '100%' };
  return <dialog ref={dialog} id="reference-editor" aria-labelledby="reference-editor-title" aria-describedby="reference-editor-description" aria-busy={busy} className={`pointer-events-auto ${dialogStyles.dialog} ${dialogStyles.centered}`} {...dialogEvents}>
    <header className={dialogStyles.header}><div className="min-w-0"><h1 id="reference-editor-title"><ImageIcon size={22} />Edit reference</h1><p id="reference-editor-description">Choose the canvas and the areas the model can change.</p></div><button ref={closeButton} type="button" data-dialog-dismiss aria-label="Close reference editor" className={dialogStyles.close} onClick={onClose} disabled={busy}><X size={20} /></button></header>
    <div data-dialog-scroll className={styles.body}>
      <div role="tablist" aria-label="Reference editing" className={styles.tabs} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
        event.preventDefault(); const index = modes.indexOf(mode); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
        setMode(modes[next]); dialog.current?.querySelector<HTMLButtonElement>(`#reference-tab-${modes[next]}`)?.focus();
      }}>{modes.map(item => <button key={item} type="button" id={`reference-tab-${item}`} role="tab" aria-selected={mode === item} aria-controls="reference-editor-panel" tabIndex={mode === item ? 0 : -1} disabled={busy} onClick={() => { finishStroke(); setMode(item); setError(''); }}>{item === 'canvas' ? 'Canvas' : item === 'mask' ? 'Mask' : 'Extend'}</button>)}</div>
      <section role="tabpanel" id="reference-editor-panel" aria-labelledby={`reference-tab-${mode}`} className="flex min-w-0 flex-col gap-3">
        {missingMask && <p className={styles.hint}>The saved mask was deleted. Paint a replacement or choose Clear edits to remove the mask from this draft.</p>}
        <div className={styles.viewport}><div className={styles.frame} style={{ '--canvas-ratio': display.width / display.height } as CSSProperties}>
          <img src={image.url} alt={image.name} draggable={false} className={styles.image} style={imageStyle} onError={() => setSourceFailed(true)} onLoad={() => setSourceFailed(false)} />
          {mode === 'mask' && !maskReason && <><canvas ref={preview} width={Math.max(1, Math.round(image.width * previewScale))} height={Math.max(1, Math.round(image.height * previewScale))} className={styles.mask} tabIndex={busy || !maskLoaded ? -1 : 0} role="group" aria-label="Mask painting canvas. Arrow keys move the brush, Space paints, and Control or Command Z undoes." onPointerDown={startStroke} onPointerMove={moveStroke} onPointerUp={() => finishStroke()} onPointerCancel={() => finishStroke(true)} onLostPointerCapture={() => finishStroke()} onFocus={() => setCursor({ x: (image.width - 1) / 2, y: (image.height - 1) / 2 })} onBlur={() => setCursor(null)} onKeyDown={event => {
            if (busy || !maskLoaded) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
            const point = cursor ?? { x: (image.width - 1) / 2, y: (image.height - 1) / 2 }, step = event.shiftKey ? brush : Math.max(1, brush / 4);
            if (event.key.startsWith('Arrow')) { event.preventDefault(); setCursor({ x: Math.max(0, Math.min(image.width - 1, point.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0))), y: Math.max(0, Math.min(image.height - 1, point.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))) }); }
            else if (event.key === ' ') { event.preventDefault(); if (history.current.length >= MAX_MASK_STROKES || history.current.reduce((sum, stroke) => sum + stroke.points.length, 0) >= MAX_MASK_POINTS) { setError('The mask history is full. Undo or reset to continue.'); return; } history.current = [...history.current, { points: [point], radius: brush / 2, erase }]; setVersion(version => version + 1); }
          }} />{cursor && <span className={styles.cursor} style={{ left: `${cursor.x / image.width * 100}%`, top: `${cursor.y / image.height * 100}%`, width: `${brush / image.width * 100}%`, height: `${brush / image.height * 100}%` }} />}</>}
        </div></div>
        <p className={`${styles.hint} ${styles.dimensions}`}>{mode === 'extend' && fitted ? `${fitted.width} × ${fitted.height} canvas · source fitted to ${fitted.sourceWidth} × ${fitted.sourceHeight}` : `${image.width} × ${image.height} source`}{mode === 'mask' ? ' · Highlighted areas will change' : ''}</p>
        {sourceFailed && <p role="alert" className="error-notice">The source preview could not be loaded. Close the editor and try again.</p>}
        {mode === 'canvas' && <><label className={styles.match}><input type="checkbox" checked={match} disabled={busy || !!matchReason} onChange={event => setMatch(event.target.checked)} /><span>Match the source canvas<span className={`block mt-1 ${styles.hint}`}>{matchReason || 'Fit this image to the model’s supported dimensions while keeping its proportions.'}</span></span></label>{match && fitted && <p className={styles.hint}>Generation canvas: {fitted.width} × {fitted.height}.</p>}</>}
        {mode === 'mask' && <>{maskReason ? <p className={styles.hint}>{maskReason}</p> : <><div className={styles.controls}><button type="button" className={styles.button} aria-pressed={!erase} disabled={busy || !maskLoaded} onClick={() => setErase(false)}><Background size={16} />Paint</button><button type="button" className={styles.button} aria-pressed={erase} disabled={busy || !maskLoaded} onClick={() => setErase(true)}>Erase</button><button type="button" className={styles.button} disabled={busy || !history.current.length} onClick={undo}><RotateCcw size={16} />Undo</button><button type="button" className={styles.button} disabled={busy} onClick={reset}>Reset mask</button><label className={styles.brush}><span>Brush</span><input aria-label="Mask brush size" type="range" min={1} max={Math.min(1024, Math.max(image.width, image.height))} value={brush} onChange={event => setBrush(Number(event.target.value))} disabled={busy || !maskLoaded} /><span className={styles.dimensions}>{brush} px</span></label></div><p className={styles.hint}>{maskLoaded ? 'Paint over the areas to regenerate. Unpainted areas stay unchanged. Use arrow keys and Space to paint with the keyboard.' : 'Loading the saved mask…'}</p></>}</>}
        {mode === 'extend' && <>{extendReason ? <p className={styles.hint}>{extendReason}</p> : <><div className={styles.padding}>{(['left', 'right', 'top', 'bottom'] as const).map(side => <label key={side}>{side[0].toUpperCase() + side.slice(1)}<input aria-label={`Extend ${side}`} type="number" inputMode="numeric" min={0} max={2048} step={model.dimensions?.multiple ?? 16} disabled={busy} value={Number.isNaN(padding[side]) ? '' : padding[side]} onChange={event => setPadding(current => ({ ...current, [side]: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label>)}</div><p className={styles.hint}>Add space in multiples of {model.dimensions?.multiple ?? 16} pixels. The source may shrink to fit the model’s canvas limit. Only the added area will change.</p>{!hasPadding && <p className={styles.hint}>Add padding on at least one side to extend the image.</p>}</>}</>}
        {(mode !== 'canvas' || match) && !fitted && !unavailable && <p role="alert" className="error-notice">This canvas does not fit the model’s limits. Reduce the padding or use a source with different proportions.</p>}
        {error && <p role="alert" className="error-notice">{error}</p>}
      </section>
    </div>
    <footer className={styles.footer}><button type="button" className={styles.button} disabled={busy} onClick={() => { onApply({}); onClose(); }}>Clear edits</button><button type="button" className={`${styles.button} ${styles.apply}`} disabled={!!applyDisabled} onClick={() => void apply()}>{busy ? 'Saving mask…' : 'Apply changes'}</button></footer>
  </dialog>;
}
