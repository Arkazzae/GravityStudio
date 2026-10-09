import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, publicJob } from "../../apps/server/store.ts";

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
