export interface ActivityJob {
  id: string; modelId: string; modelName?: string; status: string;
  createdAt: string; updatedAt?: string;
  outputs: ReadonlyArray<{ mimeType: string }>;
}
export interface ActivityEvent { id: string; message: string; at: string }
const working = new Set(['queued', 'preparing', 'running']);
const messages: Record<string, string> = {
  queued: 'added to the queue', preparing: 'loading the model', running: 'generating an image',
  succeeded: 'image ready', failed: 'generation failed', cancelled: 'generation cancelled', interrupted: 'generation needs attention',
};

/** History is informational on first load; only observed completions call out. */
export class NotificationFeed {
  private initialized = false;
  private previous = new Map<string, string>();
  private events: ActivityEvent[] = [];
  update<T extends ActivityJob>(jobs: readonly T[], now = Date.now()): { events: ActivityEvent[]; completed: T[] } {
    const completed: T[] = [];
    const additions: ActivityEvent[] = [];
    for (const job of jobs) {
      const before = this.previous.get(job.id);
      if (before === job.status || !messages[job.status]) continue;
      const timestamp = job.updatedAt || (this.initialized ? new Date(now).toISOString() : job.createdAt);
      const at = Number.isFinite(Date.parse(timestamp)) ? timestamp : new Date(now).toISOString();
      additions.push({ id: `${job.id}:${job.status}`, message: `${job.modelName || job.modelId} · ${messages[job.status]}`, at });
      if (this.initialized && before && working.has(before) && job.status === 'succeeded' && job.outputs.some(output => output.mimeType.startsWith('image/'))) completed.push(job);
    }
    this.initialized = true;
    this.previous = new Map(jobs.map(job => [job.id, job.status]));
    if (additions.length) {
      const replaced = new Set(additions.map(event => event.id));
      this.events = [...additions, ...this.events.filter(event => !replaced.has(event.id))].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 40);
    }
    return { events: this.events, completed };
  }
}
