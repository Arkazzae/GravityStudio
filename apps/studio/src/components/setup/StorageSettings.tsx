'use client';

import type { StorageUsage } from '../../../../../packages/contracts/storage';
import { copy, date, Feedback, Heading, Loading, useResource } from '@/components/admin/shared';

function size(value: number) { const unit = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10)); return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`; }
function amount(value: number | null, status = 'complete') { return value === null ? 'Unavailable' : `${status === 'partial' ? 'At least ' : ''}${size(value)}`; }
export function StorageSettings({ active = true }: { active?: boolean }) {
  const resource = useResource<StorageUsage>(active ? '/admin/storage' : null, 30_000);
  const data = resource.data, volume = data?.volume;
  return <section><Heading title="Storage" onRefresh={resource.reload} loading={resource.loading}>See disk space and the files managed by this Studio.</Heading><Feedback error={resource.error} />{resource.loading && <Loading>Reading storage usage…</Loading>}
    {data && <div className="space-y-8">
      <section><h2 className="text-lg font-medium">Server disk</h2><p className={`mt-2 ${copy}`}>The filesystem that holds Studio’s data. Its used space includes other applications.</p>
        <dl className="mt-4 divide-y divide-line border-y border-line">{[['Total capacity', volume!.totalBytes], ['Used', volume!.usedBytes], ['Free on filesystem', volume!.freeBytes], ['Available to Studio', volume!.availableBytes]].map(([label, value]) => <div key={String(label)} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><dt className="text-ink-2">{label}</dt><dd className="tabular-nums">{amount(value as number | null)}</dd></div>)}</dl>
        {volume?.status === 'available' && volume.totalBytes !== null && volume.usedBytes !== null && volume.totalBytes > 0 && <div role="meter" aria-label="Server disk used, including other applications" aria-valuemin={0} aria-valuemax={volume.totalBytes} aria-valuenow={volume.usedBytes} aria-valuetext={`${size(volume.usedBytes)} of ${size(volume.totalBytes)} used`} className="mt-4 h-1.5 overflow-hidden rounded-full bg-chip"><div className="h-full rounded-full bg-volt" style={{ width: `${Math.min(100, volume.usedBytes / volume.totalBytes * 100)}%` }} /></div>}
        {volume?.message && <p role="status" className="mt-3 text-xs leading-relaxed text-ink-2">{volume.message}</p>}
      </section>
      <section><h2 className="text-lg font-medium">Studio files</h2><p className={`mt-2 ${copy}`}>{amount(data.local.bytes, data.local.status)} in {data.local.files.toLocaleString()} files{data.local.allocatedBytes !== null ? ` · ${amount(data.local.allocatedBytes, data.local.status)} allocated on disk` : ''}.</p>
        <dl className="mt-4 divide-y divide-line border-y border-line">{data.local.categories.map(category => <div key={category.id} className="flex flex-wrap items-start justify-between gap-3 py-4 text-sm"><dt className="min-w-0 text-ink-2">{category.label}<span className="mt-1 block text-xs">{category.files.toLocaleString()} files</span></dt><dd className="tabular-nums">{amount(category.bytes, category.status)}</dd></div>)}</dl>
        {data.local.status === 'partial' && <p role="status" className="mt-3 text-xs leading-relaxed text-[#ffc3aa]">Some files could not be measured. Values marked “At least” are lower bounds.</p>}
        {data.local.warnings.length > 0 && <ul className="mt-3 space-y-2 text-xs leading-relaxed text-ink-2">{data.local.warnings.map(message => <li key={message}>{message}</li>)}</ul>}
      </section>
      <section><h2 className="text-lg font-medium">Largest model files</h2><p className={`mt-2 ${copy}`}>Image models, language models and tools saved by Studio.</p><ul className="mt-4 divide-y divide-line border-y border-line">{data.largestModelFiles.map(file => <li key={`${file.categoryId}:${file.name}`} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm"><span className="min-w-0 flex-1 basis-40 break-words [overflow-wrap:anywhere] text-ink-2">{file.name}</span><span className="tabular-nums">{size(file.bytes)}</span></li>)}</ul>{!data.largestModelFiles.length && <p className="mt-3 text-xs text-ink-2">{data.modelFilesTruncated ? 'No model files could be measured in this sample.' : 'No local model files found.'}</p>}{data.modelFilesTruncated && <p className="mt-3 text-xs leading-relaxed text-ink-2">{data.local.categories.some(category => ['image-models', 'language-models', 'tools'].includes(category.id) && category.status !== 'complete') ? 'Showing up to 20 files from the completed part of this scan. Other files may be larger.' : 'Showing the 20 largest model files.'}</p>}</section>
      <section><h2 className="text-lg font-medium">Object storage</h2><p className={`mt-2 ${copy}`}>{data.objectStorage.message}</p>
        {data.objectStorage.configured && <><dl className="mt-4 divide-y divide-line border-y border-line">{[['Managed images', data.objectStorage.bytes], ['Uploaded images', data.objectStorage.inputsBytes], ['Generated images', data.objectStorage.outputsBytes]].map(([label, value]) => <div key={String(label)} className="flex flex-wrap justify-between gap-3 py-3 text-sm"><dt className="text-ink-2">{label}</dt><dd className="tabular-nums">{amount(value as number | null, data.objectStorage.status)}</dd></div>)}</dl><p className="mt-3 text-xs leading-relaxed text-ink-2">{data.objectStorage.files.toLocaleString()} managed files. These recorded sizes do not represent the provider’s capacity or quota.{data.objectStorage.unknownSizeFiles > 0 ? ` ${data.objectStorage.unknownSizeFiles.toLocaleString()} files have an unknown size.` : ''}</p></>}
      </section>
      <p className="text-xs leading-relaxed text-ink-2">Measured {date(data.sampledAt)}. Cached until {date(data.cacheExpiresAt)}.</p>
    </div>}
  </section>;
}
