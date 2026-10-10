import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { acquireDataLease } from "../../apps/server/data-lease.ts";

test("the data lease survives garbage collection, excludes another process and is released after SIGKILL", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "gravity-process-lease-"));
  const source = new URL("../../apps/server/data-lease.ts", import.meta.url).href;
  const script = `
    import { acquireDataLease } from ${JSON.stringify(source)};
    // Retain the lease as the real server does; an ignored release callback lets SQLite be collected.
    const release = acquireDataLease(process.argv[1]);
    process.once('exit', release);
    for (let attempt = 0; attempt < 3; attempt++) {
      global.gc();
      await new Promise(resolve => setImmediate(resolve));
    }
    process.send('locked');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", script, directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await once(child, "message", { signal: AbortSignal.timeout(5000) });
  assert.equal(ready[0], "locked");
  assert.throws(() => acquireDataLease(directory), /already in use/);
  // The lease must not hold a lock on the application's actual database.
  const application = new DatabaseSync(join(directory, "studio.sqlite"));
  try { application.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY); INSERT INTO fixture VALUES (1)"); }
  finally { application.close(); }
  child.kill("SIGKILL"); await exited;
  const release = acquireDataLease(directory);
  try { assert.throws(() => acquireDataLease(directory), /already in use/); }
  finally { release(); }
  const next = acquireDataLease(directory); next();
});
