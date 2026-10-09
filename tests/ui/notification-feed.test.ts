import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationFeed, type ActivityJob } from '../../apps/studio/src/lib/notification-feed.ts';

const now = Date.UTC(2026, 9, 9, 12);
const at = (offset = 0) => new Date(now + offset).toISOString();
function job(id: string, status: string, changes: Partial<ActivityJob> = {}): ActivityJob {
  return { id, modelId: 'flux-2-klein-4b', modelName: 'FLUX.2 Klein 4B', status, createdAt: at(-60_000), updatedAt: at(), outputs: status === 'succeeded' ? [{ mimeType: 'image/png' }] : [], ...changes };
}

test('opening Studio shows recent history without announcing existing results', () => {
  const feed = new NotificationFeed();
  const snapshot = feed.update([job('earlier', 'succeeded'), job('current', 'running'), job('failed', 'failed')], now);
  assert.equal(snapshot.events.length, 3);
  assert.deepEqual(snapshot.completed, []);
  assert.ok(snapshot.events.some(event => event.message === 'FLUX.2 Klein 4B · image ready'));
  assert.ok(snapshot.events.some(event => event.message.includes('generation failed')));
  assert.deepEqual(feed.update([job('earlier', 'succeeded'), job('current', 'running'), job('failed', 'failed')], now + 5_000), snapshot);
});

test('a known queued, preparing, or running image announces its successful completion once', () => {
  for (const state of ['queued', 'preparing', 'running']) {
    const feed = new NotificationFeed();
    feed.update([job('live', state)], now);
    const finished = job('live', 'succeeded', { updatedAt: at(3_000) });
    const result = feed.update([finished], now + 3_000);
    assert.deepEqual(result.completed, [finished], state);
    assert.equal(result.events[0].id, 'live:succeeded');
    const repeated = feed.update([{ ...finished, updatedAt: at(6_000) }], now + 6_000);
    assert.deepEqual(repeated.completed, []);
    assert.equal(repeated.events.filter(event => event.id === 'live:succeeded').length, 1);
  }
});

test('progress refreshes keep a single activity entry until the job changes state', () => {
  const feed = new NotificationFeed();
  const first = feed.update([{ ...job('live', 'running'), progress: .1, stage: 'Sampling' }], now);
  for (const progress of [.25, .5, .99]) {
    const next = feed.update([{ ...job('live', 'running', { updatedAt: at(progress * 10_000) }), progress, stage: 'Sampling' }], now + progress * 10_000);
    assert.deepEqual(next.events, first.events);
    assert.deepEqual(next.completed, []);
  }
});

test('failed, cancelled, interrupted, and non-image results do not produce completion alerts', () => {
  for (const status of ['failed', 'cancelled', 'interrupted', 'succeeded']) {
    const feed = new NotificationFeed();
    feed.update([job('live', 'running')], now);
    const result = feed.update([job('live', status, { outputs: [{ mimeType: 'text/plain' }] })], now + 1_000);
    assert.deepEqual(result.completed, [], status);
    assert.ok(result.events.some(event => event.id === `live:${status}`), 'Terminal state remains visible in the activity history');
  }
});

test('results first discovered after reconnect or returning to the history never replay alerts', () => {
  const feed = new NotificationFeed();
  feed.update([job('observed', 'running')], now);
  assert.deepEqual(feed.update([job('observed', 'running'), job('unknown', 'succeeded')], now + 1_000).completed, []);
  feed.update([], now + 2_000);
  const returning = feed.update([job('observed', 'succeeded'), job('unknown', 'succeeded')], now + 3_000);
  assert.deepEqual(returning.completed, []);
  assert.equal(returning.events.filter(event => event.id === 'unknown:succeeded').length, 1);
  assert.ok(returning.events.some(event => event.id === 'observed:succeeded'));
});

test('activity dates fall back safely and the newest forty entries bound retained history', () => {
  const feed = new NotificationFeed();
  const history = Array.from({ length: 80 }, (_, index) => job(`past-${index}`, 'succeeded', { createdAt: at(index - 100), updatedAt: at(index - 100) }));
  const first = feed.update(history, now);
  assert.equal(first.events.length, 40);
  assert.equal(first.events[0].id, 'past-79:succeeded');
  assert.equal(first.events[39].id, 'past-40:succeeded');

  const withMalformed = feed.update([...history, job('malformed', 'failed', { updatedAt: 'not-a-timestamp' })], now + 5_000);
  assert.equal(withMalformed.events.length, 40);
  assert.equal(withMalformed.events[0].id, 'malformed:failed');
  assert.equal(withMalformed.events[0].at, at(5_000));
  assert.ok(withMalformed.events.every(event => Number.isFinite(Date.parse(event.at))));

  const initialMalformed = new NotificationFeed().update([job('bad-initial-date', 'queued', { createdAt: 'bad', updatedAt: undefined })], now);
  assert.equal(initialMalformed.events[0].at, at());
  const createdAtFallback = new NotificationFeed().update([job('created-date', 'queued', { updatedAt: undefined })], now);
  assert.equal(createdAtFallback.events[0].at, at(-60_000));
});

test('unknown job states are ignored and missing model names use the model identifier', () => {
  const feed = new NotificationFeed();
  const first = feed.update([job('future-state', 'future-status'), job('unnamed-model', 'queued', { modelName: undefined })], now);
  assert.deepEqual(first.completed, []);
  assert.deepEqual(first.events.map(event => event.message), ['flux-2-klein-4b · added to the queue']);
});
