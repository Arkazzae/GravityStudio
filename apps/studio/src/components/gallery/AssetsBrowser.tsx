'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Boxes, Download, FolderClosed, Heart, ImageIcon, LoaderCircle, Plus, Search, X } from '@/components/ui/icons';
import { FavoriteButton } from '@/components/ui/FavoriteButton';
import { FileDropOverlay } from '@/components/ui/FileDropOverlay';
import { api, errorMessage, type InputImage, type Job, type StudioModel } from '@/lib/api';
import { imageFileProblem } from '@/lib/image-files';
import { useFileIntake } from '@/lib/use-file-intake';
import { useRetainedDialog } from '@/lib/use-retained-dialog';
import { DeleteImageButton } from './DeleteImageButton';
import { InputViewer } from './InputViewer';
import { OutputViewer, type ViewerEntry } from './OutputViewer';
import type { UpscaleActions } from './UpscaleAction';
import dialogStyles from '@/components/studio/StudioDialog.module.css';
import libraryStyles from '@/components/prompt/ReferencePicker.module.css';
import styles from './AssetsBrowser.module.css';

type Category = 'all' | 'favorites' | 'generated' | 'imports';
type Asset = { id: string; url: string; label: string; search: string; day: string } &
  ({ source: 'generated'; entry: ViewerEntry } | { source: 'import'; input: InputImage });
const categories = [
  { id: 'all', label: 'All Assets', icon: Boxes }, { id: 'favorites', label: 'Favorites', icon: Heart },
  { id: 'generated', label: 'Generated', icon: ImageIcon }, { id: 'imports', label: 'Imports', icon: FolderClosed },
] as const;
const dayLabel = (day: string) => day === 'imports' ? 'Imported images' : new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function AssetsBrowser({ open, triggerRef, jobs, models, onClose, onReuse, onFavorite, favoriteBusy, favoriteError, onDeleteOutput, onInputDeleted, onSessionExpired, onBusyChange, upscale }: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  jobs: Job[];
  models: StudioModel[];
  onClose: () => void;
  onReuse: (job: Job) => void;
  onFavorite: (job: Job, output: Job['outputs'][number]) => void;
  favoriteBusy: ReadonlySet<string>;
  favoriteError?: string;
  onDeleteOutput: (job: Job, output: Job['outputs'][number]) => Promise<void>;
  onInputDeleted: (id: string) => void;
  onSessionExpired: () => void;
  onBusyChange: (busy: boolean) => void;
  upscale: UpscaleActions;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLDivElement>(null);
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const deletingOutputs = useRef(new Set<string>());
  const mounted = useRef(true);
  const loaded = useRef(false);
  const [folder, setFolder] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [imports, setImports] = useState<InputImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadRevision, setLoadRevision] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [inputBusy, setInputBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [outputBusy, setOutputBusy] = useState<ReadonlySet<string>>(new Set());
  const [viewer, setViewer] = useState<{ id: string; source: Asset['source']; open: boolean } | null>(null);
  const events = useRetainedDialog({ dialog, open, onClose, triggerRef, initialFocus: search });
  const callbacks = useRef({ onSessionExpired, onInputDeleted });
  callbacks.current = { onSessionExpired, onInputDeleted };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reading.current?.abort(); writing.current?.abort(); }; }, []);
  useEffect(() => { onBusyChange(inputBusy || outputBusy.size > 0); }, [inputBusy, outputBusy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    if (!open || inputBusy) return;
    const controller = new AbortController(); reading.current = controller;
    setLoading(!loaded.current); setLoadError('');
    void api<{ inputs: InputImage[] }>('/inputs', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }).then(result => {
      if (!controller.signal.aborted) { loaded.current = true; setImports(result.inputs); }
    }).catch(failure => {
      if (!controller.signal.aborted) { setLoadError(errorMessage(failure)); if (failure?.status === 401) callbacks.current.onSessionExpired(); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); if (reading.current === controller) reading.current = null; });
    return () => controller.abort();
  }, [open, inputBusy, loadRevision]);
  useEffect(() => { if (gallery.current) gallery.current.scrollTop = 0; }, [folder, query]);

  const pool = useMemo<Asset[]>(() => [
    ...jobs.flatMap(job => job.outputs.filter(output => output.mimeType.startsWith('image/')).map(output => ({
      id: output.id, url: output.url, label: job.prompt || job.modelName || job.modelId,
      search: `${job.prompt} ${job.modelName || job.modelId} ${output.width || ''} ${output.height || ''}`.toLowerCase(),
      day: job.createdAt.slice(0, 10), source: 'generated' as const, entry: { id: output.id, job, output },
    }))).sort((a, b) => b.entry.job.createdAt.localeCompare(a.entry.job.createdAt)),
    ...imports.map(input => ({ id: input.id, url: input.url, label: input.name, search: `${input.name} ${input.width} ${input.height}`.toLowerCase(), day: 'imports', source: 'import' as const, input })),
  ], [jobs, imports]);
  const visible = useMemo(() => pool.filter(asset =>
    (folder !== 'generated' || asset.source === 'generated') && (folder !== 'imports' || asset.source === 'import') &&
    (folder !== 'favorites' || asset.source === 'generated' && asset.entry.output.favorite) && (!query.trim() || asset.search.includes(query.trim().toLowerCase()))
  ), [pool, folder, query]);
  const groups = useMemo(() => {
    const grouped = new Map<string, Asset[]>();
    for (const asset of visible) { const group = grouped.get(asset.day) || []; group.push(asset); grouped.set(asset.day, group); }
    return [...grouped.entries()];
  }, [visible]);
  const outputs = useMemo(() => visible.flatMap(asset => asset.source === 'generated' ? [asset.entry] : []), [visible]);
  const inputImages = useMemo(() => visible.flatMap(asset => asset.source === 'import' ? [asset.input] : []), [visible]);
  const imageBusy = useMemo(() => new Set([...favoriteBusy, ...outputBusy]), [favoriteBusy, outputBusy]);

  async function upload(files: File[]) {
    if (!files.length || writing.current) return;
    const problem = imageFileProblem(files);
    if (problem) { setError(problem); return; }
    reading.current?.abort();
    const controller = new AbortController(); writing.current = controller;
    setInputBusy(true); setUploading(true); setError(''); setNotice('');
    let added = 0;
    try {
      for (const file of files) {
        const input = await api<InputImage>('/inputs', { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) }, body: file, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]) });
        if (controller.signal.aborted) return;
        added++; setImports(current => [input, ...current.filter(item => item.id !== input.id)]);
      }
      setNotice(`${added} image${added === 1 ? '' : 's'} added to the library.`);
    } catch (failure) {
      if (!controller.signal.aborted) { setError(`${added ? `${added} image${added === 1 ? '' : 's'} added. ` : ''}${errorMessage(failure)}`); if ((failure as { status?: number }).status === 401) callbacks.current.onSessionExpired(); }
    } finally {
      if (writing.current === controller) writing.current = null;
      if (mounted.current) { setInputBusy(false); setUploading(false); }
    }
  }
  async function removeInput(input: InputImage) {
    if (writing.current) throw new Error('Wait for the current file operation to finish.');
    reading.current?.abort();
    const controller = new AbortController(); writing.current = controller; setInputBusy(true); setNotice('');
    try {
      await api(`/inputs/${encodeURIComponent(input.id)}`, { method: 'DELETE', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (controller.signal.aborted || !mounted.current) return;
      setImports(current => current.filter(item => item.id !== input.id)); callbacks.current.onInputDeleted(input.id);
    } catch (failure) {
      if (!controller.signal.aborted && (failure as { status?: number }).status === 401) callbacks.current.onSessionExpired();
      throw failure;
    } finally { if (writing.current === controller) writing.current = null; if (mounted.current) setInputBusy(false); }
  }
  async function removeOutput(job: Job, output: Job['outputs'][number]) {
    const key = `${job.id}:${output.id}`;
    if (deletingOutputs.current.has(key)) return;
    deletingOutputs.current.add(key); setOutputBusy(new Set(deletingOutputs.current));
    try { await onDeleteOutput(job, output); }
    finally { deletingOutputs.current.delete(key); if (mounted.current) setOutputBusy(new Set(deletingOutputs.current)); }
  }
  const closeViewer = () => setViewer(current => current ? { ...current, open: false } : null);
  const selectViewer = (id: string) => setViewer(current => current ? { ...current, id } : null);
  const { dragging } = useFileIntake({ onFiles: files => { void upload(files); }, enabled: open, dialogRef: dialog });
  return <>
    <dialog ref={dialog} id="assets-browser-dialog" aria-labelledby="assets-browser-title" className={`${dialogStyles.dialog} ${dialogStyles.centered} ${libraryStyles.picker}`} {...events}>
      <div className={styles.layout}>
        <header className={libraryStyles.header}>
          <h2 id="assets-browser-title">Assets</h2>
          <label className={libraryStyles.headerSearch}><Search size={17} /><input ref={search} value={query} aria-label="Search assets" placeholder="Search assets" onChange={event => setQuery(event.target.value)} /></label>
          <div className={styles.headerActions}>
            <input ref={uploadInput} hidden type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="Upload images" disabled={inputBusy} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void upload(files); }} />
            <button type="button" className={styles.upload} aria-label="Upload images" title="Upload images" disabled={inputBusy} onClick={() => uploadInput.current?.click()}>{uploading ? <LoaderCircle size={19} className="animate-spin motion-reduce:animate-none" /> : <Plus size={21} />}<span>Upload</span></button>
            <button data-dialog-dismiss type="button" className={dialogStyles.close} aria-label="Close assets" title="Close assets" onClick={onClose}><X size={20} /></button>
          </div>
        </header>
        <div className={libraryStyles.body}>
          <nav data-dialog-scroll className={libraryStyles.sidebar} aria-label="Asset categories">
            {categories.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={libraryStyles.navItem} aria-current={folder === id ? 'page' : undefined} onClick={() => setFolder(id)}>
              <Icon className={id === 'imports' ? libraryStyles.folderIcon : undefined} /><span className={libraryStyles.navLabel}>{label}</span><span className={libraryStyles.count}>{pool.filter(asset => id === 'all' || id === 'imports' && asset.source === 'import' || id === 'generated' && asset.source === 'generated' || id === 'favorites' && asset.source === 'generated' && asset.entry.output.favorite).length}</span>
            </button>)}
          </nav>
          <div ref={gallery} data-dialog-scroll className={libraryStyles.gallery} aria-label="Asset gallery" aria-busy={loading}>
            {loading && <p className={libraryStyles.loadStatus} role="status">Loading imported images…</p>}
            {loadError && <p className={libraryStyles.loadError} role="alert">{loadError} <button onClick={() => setLoadRevision(current => current + 1)}>Try again</button></p>}
            {favoriteError && <p className={libraryStyles.loadError} role="alert">{favoriteError}</p>}
            {error && <p className={libraryStyles.loadError} role="alert">{error}</p>}
            {(uploading || notice) && <p className={libraryStyles.loadStatus} role="status">{uploading ? 'Adding images to your library…' : notice}</p>}
            {groups.map(([day, group]) => <section key={day} className={libraryStyles.group} aria-label={dayLabel(day)}>
              <h3 className={libraryStyles.groupHeader}>{dayLabel(day)}</h3>
              <div className={libraryStyles.grid}>{group.map(asset => <article key={asset.id} data-asset-id={asset.id} data-source={asset.source} className={`${libraryStyles.card} ${styles.card}`}>
                <button type="button" className={libraryStyles.openCard} aria-label={`Open ${asset.label}`} title={asset.label} onClick={() => setViewer({ id: asset.id, source: asset.source, open: true })}>
                  <img src={asset.url} alt={asset.label} loading="lazy" decoding="async" draggable={false} className={`image-checkerboard ${libraryStyles.media}`} /><span className={libraryStyles.cardOverlay} /><span className={libraryStyles.caption}>{asset.label}</span>
                </button>
                <div className={styles.cardActions}>
                  {asset.source === 'generated' && <FavoriteButton favorite={!!asset.entry.output.favorite} busy={imageBusy.has(`${asset.entry.job.id}:${asset.id}`)} onClick={() => onFavorite(asset.entry.job, asset.entry.output)} />}
                  <a href={asset.url} download={asset.source === 'import' ? `${asset.input.name.replace(/\.(png|jpe?g|webp)$/i, '')}.png` : true} draggable={false} aria-label="Download image" title="Download image" className={styles.download}><Download size={16} /></a>
                  {(asset.source === 'import' || ['succeeded', 'failed', 'cancelled'].includes(asset.entry.job.status)) && <DeleteImageButton disabled={asset.source === 'import' ? inputBusy : imageBusy.has(`${asset.entry.job.id}:${asset.id}`)} onError={setError} onDelete={() => asset.source === 'import' ? removeInput(asset.input) : removeOutput(asset.entry.job, asset.entry.output)} />}
                </div>
              </article>)}</div>
            </section>)}
            {!visible.length && !loading && !loadError && !(folder === 'favorites' && favoriteError) && <div className={libraryStyles.empty}><FolderClosed strokeWidth={1.5} /><h3>{query.trim() ? 'No matching assets' : folder === 'favorites' ? 'No favorites yet.' : 'No assets here'}</h3><p>{query.trim() ? 'Try a different search.' : folder === 'favorites' ? 'Use the heart on a generated image to save it here.' : 'Upload images or generate something in Studio.'}</p></div>}
          </div>
        </div>
        {dragging && <FileDropOverlay target="assets" title="Add images to your library" detail={uploading ? 'Wait for the current upload to finish.' : 'Drop PNG, JPEG or WebP images up to 20 MiB each.'} />}
      </div>
    </dialog>
    {viewer?.source === 'generated' && <OutputViewer dialogId="assets-output-viewer" items={outputs} open={open && viewer.open} openId={viewer.id} models={models} onClose={closeViewer} onSelect={selectViewer} onReuse={job => { onReuse(job); onClose(); }} onFavorite={onFavorite} favoriteBusy={imageBusy} favoriteError={favoriteError} onDelete={removeOutput} upscale={upscale} />}
    {viewer?.source === 'import' && <InputViewer items={inputImages} open={open && viewer.open} openId={viewer.id} onClose={closeViewer} onSelect={selectViewer} onDelete={removeInput} upscale={upscale} />}
  </>;
}
