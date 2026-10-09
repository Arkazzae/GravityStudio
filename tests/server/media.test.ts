import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../apps/server/store.ts";
import { saveOutput } from "../../apps/server/media.ts";

test("a PNG with readable headers but corrupt compressed pixels is never saved as a successful output", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-media-"));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const corrupt = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64");
  await assert.rejects(saveOutput(store, "d9c94c4a-22fa-4475-a3b9-ae3c25268f6f", 0, corrupt), { code: "INVALID_OUTPUT" });
  assert.equal((await readdir(directory)).includes("outputs"), false);
});
