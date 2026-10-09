'use client';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Boxes, Check, FolderClosed, Heart, ImageIcon, LoaderCircle, Search, X } from '@/components/ui/icons';
import { api, errorMessage, type InputImage, type Job } from '@/lib/api';
import { useRetainedDialog } from '@/lib/use-retained-dialog';
import dialogStyles from '@/components/studio/StudioDialog.module.css';
import styles from './ReferencePicker.module.css';

interface Asset {
  id: string; url: string; label: string; search: string; mimeType: string;
  source: 'generated' | 'import'; day?: string; createdAt?: string;
  favorite?: boolean;
}
type Category = 'all' | 'favorites' | 'image' | 'imports';
const categories = [{ id: 'all', label: 'All Assets', icon: Boxes }, { id: 'favorites', label: 'Favorites', icon: Heart }, { id: 'image', label: 'Image', icon: ImageIcon }, { id: 'imports', label: 'Imports', icon: FolderClosed }] as const;
const dateLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function ReferencePicker({ open, triggerRef, jobs, max = 1, onPick, onClose, favoriteError, unavailableReason }: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  jobs: Job[];
  max?: number;
  onPick: (files: File[], signal: AbortSignal) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  favoriteError?: string;
  unavailableReason?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const selectedAssets = useRef(new Map<string, Asset>());
  const importsLoaded = useRef(false);
  const gallery = useRef<HTMLDivElement>(null);
  const [folder, setFolder] = useState<Category>('image');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [imports, setImports] = useState<InputImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadRevision, setLoadRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogEvents = useRetainedDialog({ dialog, open, onClose, triggerRef, initialFocus: search, dismissible: !busy });
  const limit = Math.max(0, max);
  const pool = useMemo<Asset[]>(() => [
    ...jobs.flatMap(job => job.outputs.filter(output => output.mimeType.startsWith('image/')).map(output => ({
      id: output.id, url: output.url, mimeType: output.mimeType, label: job.prompt || job.modelName || job.modelId,
      search: `${job.prompt} ${job.modelName || job.modelId} ${output.width || ''} ${output.height || ''}`.toLowerCase(),
      source: 'generated' as const, day: job.createdAt.slice(0, 10), createdAt: job.createdAt,
      favorite: !!output.favorite,
    }))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ...imports.map(input => ({ id: input.id, url: input.url, mimeType: 'image/png', label: input.name,
      search: `${input.name} imported ${input.width} ${input.height}`.toLowerCase(), source: 'import' as const })),
  ], [jobs, imports]);
  const chosen = useMemo(() => {
    const byId = new Map(pool.map(asset => [asset.id, asset]));
    return picked.map(id => byId.get(id) || selectedAssets.current.get(id)).filter((asset): asset is Asset => !!asset);
  }, [pool, picked]);
  const groups = useMemo(() => {
    const text = query.trim().toLowerCase();
    const grouped = new Map<string, Asset[]>();
    for (const asset of pool) {
      if ((folder === 'imports' && asset.source !== 'import') || (folder === 'favorites' && !asset.favorite) || (text && !asset.search.includes(text))) continue;
      const day = asset.day || 'imports';
      const group = grouped.get(day) || [];
      group.push(asset); grouped.set(day, group);
    }
    return [...grouped.entries()];
  }, [pool, folder, query]);

  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(!importsLoaded.current); setLoadError('');
    void api<{ inputs: InputImage[] }>('/inputs', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { importsLoaded.current = true; setImports(result.inputs); }
    }).catch(failure => { if (!controller.signal.aborted) setLoadError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, loadRevision]);
  useEffect(() => { if (gallery.current) gallery.current.scrollTop = 0; }, [folder, query]);

  function toggle(id: string) {
    const asset = pool.find(entry => entry.id === id);
    if (asset) selectedAssets.current.set(id, asset);
    setError('');
    setPicked(current => current.includes(id) ? current.filter(entry => entry !== id)
      : limit === 1 ? [id] : current.length >= limit ? current : [...current, id]);
  }
  async function confirm() {
    if (!picked.length || request.current || busy) return;
    if (chosen.length !== picked.length) { setPicked(chosen.map(asset => asset.id)); setError('An asset is no longer available. Review your selection.'); return; }
    if (chosen.length > limit) { setError(`Choose up to ${limit} reference images for this model.`); return; }
    const controller = new AbortController();
    request.current = controller; setBusy(true); setError('');
    try {
      const files: File[] = [];
      for (const asset of chosen) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
        const response = await fetch(asset.url, { credentials: 'same-origin', signal });
        if (!response.ok) throw new Error('An image could not be loaded. Try again or choose another image.');
        const blob = await response.blob();
        signal.throwIfAborted();
        const extension = asset.mimeType === 'image/jpeg' ? 'jpg' : asset.mimeType === 'image/webp' ? 'webp' : 'png';
        files.push(new File([blob], asset.source === 'import' ? asset.label : `reference-${asset.id}.${extension}`, { type: asset.mimeType }));
      }
      const result = await onPick(files, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ok) { setPicked([]); selectedAssets.current.clear(); onClose(); }
      else setError(result.error || 'The references could not be added. Try again.');
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input'))
      .filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  const full = picked.length >= limit;
  return <dialog ref={dialog} id="reference-picker-dialog" aria-labelledby="reference-picker-title" className={`pointer-events-auto ${dialogStyles.dialog} ${dialogStyles.centered} ${styles.picker}`}
    onKeyDown={keepFocus} {...dialogEvents}>
    <div className={styles.layout}>
      <header className={styles.header}>
        <h2 id="reference-picker-title">Choose from assets</h2>
        <label className={styles.headerSearch}><Search size={17} /><input ref={search} value={query} aria-label="Search assets" placeholder="Search assets" onChange={event => setQuery(event.target.value)} /></label>
        <button data-dialog-dismiss type="button" className={dialogStyles.close} aria-label="Close assets" title="Close assets" disabled={busy} onClick={onClose}><X size={20} /></button>
      </header>
      <div className={styles.body}>
        <nav data-dialog-scroll className={styles.sidebar} aria-label="Asset categories">
          {categories.map(({ id, label, icon: Icon }) => <div key={id}>
            {(id === 'image' || id === 'imports') && <p className={styles.sectionLabel}>{id === 'image' ? 'Type' : 'Folders'}</p>}
            <button type="button" className={styles.navItem} aria-current={folder === id ? 'page' : undefined} onClick={() => setFolder(id)}>
              <Icon className={id === 'imports' ? styles.folderIcon : undefined} /><span className={styles.navLabel}>{label}</span><span className={styles.count}>{id === 'imports' ? imports.length : id === 'favorites' ? pool.filter(asset => asset.favorite).length : pool.length}</span>
            </button>
          </div>)}
        </nav>
        <div ref={gallery} data-dialog-scroll className={styles.gallery} aria-label="Asset gallery" aria-busy={loading}>
          {loading && <p className={styles.loadStatus} role="status">Loading imported images…</p>}
          {loadError && <p className={styles.loadError} role="alert">Imported images could not be loaded. {loadError} <button type="button" onClick={() => setLoadRevision(current => current + 1)}>Try again</button></p>}
          {favoriteError && <p className={styles.loadError} role="alert">{favoriteError}</p>}
          {groups.map(([day, group]) => <section key={day} className={styles.group} aria-label={day === 'imports' ? 'Imported images' : dateLabel(day)}>
            <h3 className={styles.groupHeader}>{day === 'imports' ? 'Imported images' : <time dateTime={day}>{dateLabel(day)}</time>}</h3>
            <div className={styles.grid}>{group.map(asset => {
              const selected = picked.includes(asset.id), blocked = !selected && full && limit !== 1;
              return <article key={asset.id} data-asset-id={asset.id} data-source={asset.source} className={styles.card} data-selected={selected} data-disabled={blocked}>
                <button type="button" className={styles.openCard} disabled={blocked || busy} aria-pressed={selected} aria-label={`${selected ? 'Deselect' : 'Select'} ${asset.label}`} title={blocked ? `Choose up to ${limit}.` : asset.label} onClick={() => toggle(asset.id)}>
                  <img src={asset.url} alt={asset.label} loading="lazy" decoding="async" className={styles.media} />
                  <span className={styles.cardOverlay} /><span className={styles.caption}>{asset.label}</span>
                </button><span className={styles.mark} aria-hidden="true"><Check strokeWidth={3} /></span>
              </article>;
            })}</div>
          </section>)}
          {!groups.length && !loading && !loadError && !(folder === 'favorites' && favoriteError) && <div className={styles.empty}>
            <FolderClosed strokeWidth={1.5} /><h3>{query.trim() ? 'No matching assets' : folder === 'favorites' ? 'No favorites yet.' : 'No assets here'}</h3>
            <p>{query.trim() ? 'Try a different search.' : folder === 'favorites' ? 'Images you favorite in the gallery will appear here.' : folder === 'imports' ? 'Upload a reference image from your device to find it here.' : 'Generate or upload an image to use it as a reference.'}</p>
          </div>}
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.selection}><p className={`${styles.status} ${error ? styles.error : ''}`} role={error ? 'alert' : 'status'} aria-live="polite">{error || unavailableReason || (picked.length ? `${picked.length} selected${limit > 1 ? ` of ${limit}` : ''}` : limit > 1 ? `Choose up to ${limit}` : limit ? 'Choose an asset' : 'Reference limit reached.')}</p>{!!picked.length && <button type="button" className={styles.clear} disabled={busy} onClick={() => { setPicked([]); selectedAssets.current.clear(); setError(''); }}>Clear selection</button>}</div>
        <div className={styles.actions}><button data-dialog-dismiss type="button" className={styles.ghost} disabled={busy} onClick={onClose}>Cancel</button><button type="button" className={styles.confirm} disabled={!picked.length || busy || picked.length > limit} aria-busy={busy} onClick={() => void confirm()}>
          {busy && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}{busy ? 'Adding…' : 'Use selected'}
        </button></div>
      </footer>
    </div>
  </dialog>;
}
