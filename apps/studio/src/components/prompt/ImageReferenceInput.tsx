'use client';

import { useRef } from 'react';
import { Library, LoaderCircle, Plus, X } from 'lucide-react';
import type { InputImage } from '@/lib/api';

export function ImageReferenceInput({ images, maxImages, uploading, onUpload, onRemove, onClear, onBrowse }: {
  images: InputImage[];
  maxImages: number;
  uploading: boolean;
  onUpload: (files: File[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onBrowse: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const multiple = maxImages > 1;
  const canAdd = images.length < maxImages;

  const unavailable = uploading ? 'Uploading images…' : maxImages < 1 ? 'Reference images are not supported by this model.' : !canAdd ? 'Reference limit reached. Remove an image to add another.' : null;

  return <div className="flex min-w-0 max-w-full shrink-0 flex-col gap-2">
    <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" multiple={multiple}
      aria-label="Upload reference images" className="sr-only" tabIndex={-1} disabled={!canAdd || uploading}
      onChange={event => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (canAdd && !uploading && files.length) onUpload(files);
      }} />
    <div className="flex flex-wrap items-center gap-2 pr-1 pt-1" role="group" aria-label="Selected reference images">
      {images.map((image, index) => <div key={image.id} className="relative size-10 shrink-0">
        <img src={image.url} alt={`Reference ${index + 1}: ${image.name}`} title={image.name} className="size-full rounded-chip object-cover" />
        <span className="absolute bottom-0.5 left-0.5 rounded bg-black/80 px-1 text-[10px] leading-4 text-white">{index + 1}</span>
        <button type="button" aria-label={`Remove reference ${index + 1}`} title={`Remove ${image.name}`} disabled={uploading}
          onClick={() => onRemove(image.id)}
          className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-raise text-ink-2 ring-1 ring-line-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-volt disabled:opacity-50">
          <X className="size-3" strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>)}
      <button type="button" aria-label="Add reference image" title={unavailable || 'Add reference image'} disabled={!canAdd || uploading}
        onClick={() => picker.current?.click()}
        className="flex size-10 shrink-0 items-center justify-center rounded-chip bg-white/[0.03] text-ink-2 ring-1 ring-line-2 transition-colors hover:bg-white/[0.09] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-volt/40 disabled:opacity-50">
        {uploading ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={2} aria-hidden="true" /> : <Plus className="size-[19px]" strokeWidth={2} aria-hidden="true" />}
      </button>
      <button type="button" aria-label="Browse saved images" title={unavailable || 'Choose a saved image as a reference'} disabled={!canAdd || uploading}
        onClick={onBrowse}
        className="flex size-10 shrink-0 items-center justify-center rounded-chip bg-white/[0.03] text-ink-2 ring-1 ring-line-2 transition-colors hover:bg-white/[0.09] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-volt/40 disabled:opacity-50">
        <Library className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
    {images.length > 0 && <div className="flex items-center gap-3 text-[12px] text-ink-2">
      <span aria-live="polite">{images.length} reference{images.length === 1 ? '' : 's'}</span>
      <button type="button" onClick={onClear} disabled={uploading} className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-volt disabled:opacity-50">Remove all</button>
    </div>}
  </div>;
}
