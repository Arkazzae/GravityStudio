import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store, publicJob } from "../../apps/server/store.ts";
import type { SavedOutput } from "../../packages/contracts/index.ts";

function completedJob(store: Store, userId: string, key: string) {
  const job = store.createJob(userId, { modelId: "sdxl", prompt: key }, { graph: { checkpoint: "original.safetensors" } }, [], "SDXL", { seed: 42 }, key, key);
  const outputs: SavedOutput[] = [0, 1].map(index => {
    const id = createHash("sha256").update(`${job.id}:${index}`).digest("hex").slice(0, 32);
    const output = { id, url: `/api/jobs/${job.id}/outputs/${id}`, mimeType: "image/png", width: 1, height: 1, bytes: 10, sha256: "fixture" };
    store.saveOutput(job.id, { ...output, path: join(store.directory, `${id}.png`) });
    return output;
  });
  store.patchJob(job.id, { status: "preparing" });
  return { job: store.patchJob(job.id, { status: "succeeded", outputs }), outputs };
}

test("jobs survive restart with their original recipe and idempotency key", () => {
  const directory = mkdtempSync(join(tmpdir(), "gravity-store-"));
  let store = new Store(directory);
  try {
    const owner = store.createOwner("owner", "hash");
    const input = { modelId: "sdxl", prompt: "A mountain", seed: 42 };
    const snapshot = { model: { id: "sdxl", revision: "one" }, graph: { checkpoint: "original.safetensors" } };
    const first = store.createJob(owner.id, input, snapshot, [], "SDXL", { seed: 42 }, "request-one", "hash-one");
    store.close();
    store = new Store(directory);
    const recovered = store.job(first.id, owner.id);
    assert.deepEqual(recovered.snapshot, snapshot);
    assert.equal(recovered.status, "queued");
    assert.equal(store.createJob(owner.id, input, { new: "revision" }, [], "SDXL", {}, "request-one", "hash-one").id, first.id);
    assert.equal(store.jobs(owner.id).length, 1);
    assert.throws(() => store.createJob(owner.id, { ...input, prompt: "Changed" }, snapshot, [], "SDXL", {}, "request-one", "different"), /different settings/);
    assert.throws(() => store.job(first.id, "someone-else"), /does not exist/);
    assert.equal("snapshot" in publicJob(recovered), false);
    assert.equal("placements" in publicJob(recovered), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("settings revisions prevent lost updates; completed jobs cannot run again", () => {
  const directory = mkdtempSync(join(tmpdir(), "gravity-store-"));
  const store = new Store(directory);
  try {
    const settings = store.settings();
    assert.equal(store.saveSettings(settings).revision, 1);
    assert.throws(() => store.saveSettings(settings), /another window/);
    const owner = store.createOwner("owner", "hash");
    assert.throws(() => store.createOwner("second", "hash"), /already has an owner/);
    const job = store.createJob(owner.id, { modelId: "sdxl", prompt: "Hello" }, {}, [], "SDXL", {}, "key", "hash");
    store.patchJob(job.id, { status: "preparing", workerId: "first" });
    store.patchJob(job.id, { submissionStarted: true });
    store.patchJob(job.id, { status: "running", promptId: "remote-id" });
    store.patchJob(job.id, { status: "succeeded" });
    assert.equal(store.activeJobs().length, 0);
    assert.throws(() => store.patchJob(job.id, { status: "running" }), /Invalid job transition/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("output favorites are owner-scoped, idempotent and survive restart without changing execution records", () => {
  const directory = mkdtempSync(join(tmpdir(), "gravity-favorites-"));
  let store = new Store(directory);
  try {
    const owner = store.createOwner("owner", "hash");
    const { job, outputs } = completedJob(store, owner.id, "favorite-generation");
    const rawBefore = store.db.prepare("SELECT body FROM jobs WHERE id=?").get(job.id);
    assert.deepEqual(publicJob(store.job(job.id)).outputs.map(output => output.favorite), [false, false]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = store.setOutputFavorite(job.id, outputs[0].id, owner.id, true);
      assert.deepEqual(publicJob(result).outputs.map(output => output.favorite), [true, false]);
      assert.equal(result.updatedAt, job.updatedAt);
    }
    assert.equal((store.db.prepare("SELECT count(*) AS count FROM output_favorites").get() as { count: number }).count, 1);
    assert.deepEqual(store.db.prepare("SELECT body FROM jobs WHERE id=?").get(job.id), rawBefore, "favoriting does not mutate the job or immutable workflow");
    assert.throws(() => store.setOutputFavorite(job.id, outputs[0].id, "another-owner", false), { code: "JOB_NOT_FOUND" });
    assert.deepEqual(store.favorites("another-owner"), []);
    assert.throws(() => store.setOutputFavorite(job.id, "missing-output", owner.id, true), { code: "OUTPUT_NOT_FOUND" });

    store.patchJob(job.id, { outputs: outputs.map(output => ({ ...output })) });
    assert.equal(publicJob(store.job(job.id)).outputs[0].favorite, true, "engine output updates cannot overwrite favorite state");
    const rawAfter = JSON.parse((store.db.prepare("SELECT body FROM jobs WHERE id=?").get(job.id) as { body: string }).body);
    assert.equal("favorite" in rawAfter.outputs[0], false, "favorites remain a read projection");
    assert.deepEqual(rawAfter.snapshot, job.snapshot);
    store.close(); store = new Store(directory);
    assert.deepEqual(publicJob(store.jobs(owner.id)[0]).outputs.map(output => output.favorite), [true, false]);
    store.setOutputFavorite(job.id, outputs[1].id, owner.id, true);
    store.setOutputFavorite(job.id, outputs[0].id, owner.id, false);
    store.setOutputFavorite(job.id, outputs[0].id, owner.id, false);
    assert.deepEqual(publicJob(store.job(job.id)).outputs.map(output => output.favorite), [false, true]);
    assert.deepEqual(store.favorites(owner.id)[0].outputs.map(output => output.id), [outputs[1].id]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("favorites include older jobs beyond the regular history limit and only their selected outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "gravity-favorite-history-"));
  const store = new Store(directory);
  try {
    const owner = store.createOwner("owner", "hash");
    const { job, outputs } = completedJob(store, owner.id, "old-favorite");
    store.db.prepare("UPDATE jobs SET created_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", job.id);
    store.setOutputFavorite(job.id, outputs[1].id, owner.id, true);
    for (let index = 0; index < 105; index++) store.createJob(owner.id, { modelId: "sdxl", prompt: "New image" }, {}, [], "SDXL", {}, `recent-${index}`, `recent-${index}`);
    assert.equal(store.jobs(owner.id).length, 100);
    assert.equal(store.jobs(owner.id).some(item => item.id === job.id), false);
    const favorites = store.favorites(owner.id).map(publicJob);
    assert.equal(favorites.length, 1);
    assert.equal(favorites[0].id, job.id);
    assert.deepEqual(favorites[0].outputs.map(output => ({ id: output.id, favorite: output.favorite })), [{ id: outputs[1].id, favorite: true }]);
    store.setOutputFavorite(job.id, outputs[1].id, owner.id, false);
    assert.deepEqual(store.favorites(owner.id), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
