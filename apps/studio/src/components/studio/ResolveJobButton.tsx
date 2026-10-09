'use client';
import { useState } from 'react';
import { api, errorMessage, type Job } from '@/lib/api';

export function ResolveJobButton({ job, onChange }: { job: Job; onChange: () => void }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  async function closeUnknownJob() {
    if (!window.confirm('Close this unknown generation?\n\nFirst check that ComfyUI is no longer running it. Gravity will recheck the worker’s queue and history before marking it failed and releasing its reserved resources.\n\nThe generation will not be submitted again. Any result that appears later will not be recovered automatically.')) return;
    setChecking(true); setError('');
    try { await api(`/jobs/${encodeURIComponent(job.id)}/resolve`, { method: 'POST', body: JSON.stringify({ acknowledge: true }) }); }
    catch (error) { setError(errorMessage(error)); }
    finally { setChecking(false); onChange(); }
  }
  return <div className="mt-1"><button disabled={checking} onClick={() => void closeUnknownJob()} className="text-xs text-ink-2 underline underline-offset-4 disabled:opacity-50">{checking ? 'Checking worker…' : 'Close unknown job'}</button>{error && <p role="alert" className="mt-2 text-xs leading-relaxed text-[#ffc3aa]">{error}</p>}</div>;
}
