import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../apps/server/store.ts";
import { deleteOutput, recoverOutputDeletions, saveOutput } from "../../apps/server/media.ts";
import { PNG } from "../inference/fake-comfy.ts";

test("a PNG with readable headers but corrupt compressed pixels is never saved as a successful output", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-media-"));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const corrupt = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64");
  await assert.rejects(saveOutput(store, "d9c94c4a-22fa-4475-a3b9-ae3c25268f6f", 0, corrupt), { code: "INVALID_OUTPUT" });
  assert.equal((await readdir(directory)).includes("outputs"), false);
});

async function completed(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "gravity-media-delete-"));
  let store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = store.createOwner("owner", "fixture-hash");
  const job = store.createJob(owner.id, { modelId: "sdxl-base", prompt: "Keep generation metadata", seed: 12 }, { immutable: true }, [], "SDXL", { steps: 20 }, "delete-output", "delete-output");
  const outputs = [await saveOutput(store, job.id, 0, PNG), await saveOutput(store, job.id, 1, PNG)];
  store.patchJob(job.id, { status: "preparing" });
  store.patchJob(job.id, { status: "succeeded", outputs });
  for (const output of outputs) store.setOutputFavorite(job.id, output.id, owner.id, true);
  return { directory, owner, job, outputs, get store() { return store; }, restart() { store.close(); store = new Store(directory); } };
}

test("failed file deletion keeps the output and favorite until a successful retry removes only that image", async t => {
  const f = await completed(t);
  const original = f.store.job(f.job.id);
  const [first, second] = f.outputs.map(output => f.store.output(f.job.id, output.id, f.owner.id));
  await rm(first.path);
  await mkdir(first.path);
  await assert.rejects(deleteOutput(f.store, f.job.id, first.id, f.owner.id), { code: "OUTPUT_DELETE_FAILED", status: 503 });
  assert.deepEqual(f.store.job(f.job.id), original);
  assert.equal(f.store.favorites(f.owner.id)[0].outputs.length, 2);
  assert.equal(f.store.pendingOutputDeletions().length, 1);
  assert.throws(() => f.store.setOutputFavorite(f.job.id, first.id, f.owner.id, false), { code: "OUTPUT_DELETION_PENDING" });

  await rm(first.path, { recursive: true });
  await writeFile(first.path, PNG);
  const deleted = await deleteOutput(f.store, f.job.id, first.id, f.owner.id);
  assert.deepEqual(deleted, { ...original, outputs: [original.outputs[1]] });
  await assert.rejects(readFile(first.path), { code: "ENOENT" });
  assert.deepEqual(await readFile(second.path), Buffer.from(PNG));
  assert.deepEqual(f.store.favorites(f.owner.id)[0].outputs.map(output => output.id), [second.id]);
  assert.deepEqual(f.store.pendingOutputDeletions(), []);
  assert.throws(() => f.store.output(f.job.id, first.id, f.owner.id), { code: "OUTPUT_NOT_FOUND" });
});

test("restart finishes deletion intents before unlink and after a failed database commit without changing generation metadata", async t => {
  const f = await completed(t);
  const original = f.store.job(f.job.id);
  const [first, second] = f.outputs.map(output => f.store.output(f.job.id, output.id, f.owner.id));
  f.store.beginOutputDeletion(f.job.id, first.id, f.owner.id);
  f.store.db.exec("CREATE TRIGGER fixture_delete_failure BEFORE DELETE ON outputs BEGIN SELECT RAISE(ABORT, 'fixture database failure'); END");
  await assert.rejects(deleteOutput(f.store, f.job.id, second.id, f.owner.id), /fixture database failure/);
  assert.deepEqual(await readFile(first.path), Buffer.from(PNG));
  await assert.rejects(readFile(second.path), { code: "ENOENT" });
  assert.deepEqual(f.store.job(f.job.id), original);
  assert.equal(f.store.pendingOutputDeletions().length, 2);

  f.restart();
  f.store.db.exec("DROP TRIGGER fixture_delete_failure");
  await recoverOutputDeletions(f.store);
  assert.deepEqual(f.store.job(f.job.id), { ...original, outputs: [] });
  assert.deepEqual(f.store.pendingOutputDeletions(), []);
  assert.deepEqual(f.store.favorites(f.owner.id), []);
  for (const output of [first, second]) await assert.rejects(readFile(output.path), { code: "ENOENT" });
  const retry = f.store.idempotentJob(f.owner.id, "delete-output", "delete-output");
  assert.equal(retry!.id, f.job.id);
  assert.deepEqual(retry!.outputs, []);
});

test("deletion refuses stored paths and symlinks outside the output's own regular file", async t => {
  const f = await completed(t);
  const output = f.store.output(f.job.id, f.outputs[0].id, f.owner.id);
  const otherPath = join(f.directory, "keep.png");
  await writeFile(otherPath, PNG);
  f.store.saveOutput(f.job.id, { ...output, path: otherPath });
  await assert.rejects(deleteOutput(f.store, f.job.id, output.id, f.owner.id), { code: "OUTPUT_DELETE_FAILED" });
  assert.deepEqual(await readFile(otherPath), Buffer.from(PNG));

  f.store.saveOutput(f.job.id, output);
  await rm(output.path);
  await symlink(otherPath, output.path);
  await assert.rejects(deleteOutput(f.store, f.job.id, output.id, f.owner.id), { code: "OUTPUT_DELETE_FAILED" });
  assert.deepEqual(await readFile(otherPath), Buffer.from(PNG));
  assert.equal(f.store.job(f.job.id).outputs.length, 2);
});
