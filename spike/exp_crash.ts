// Q5: hard-kill behaviour. Usage: exp_crash.ts <iterations> [target]
// Each iteration: fresh db + replica, long-lived litestream, writer commits in a
// loop and confirms every 7th commit with a forced sync (the outbox's wait).
// At a random point:
//   A) kill -9 litestream and abandon the machine: restore from the replica
//      alone. Invariant: every confirmed commit is present; record the loss
//      window (committed but unconfirmed).
//   B) kill -9 litestream, restart it on the same local files: everything
//      committed must reach the replica.
//   C) kill -9 a writer child process mid-loop (the CLI dying): litestream
//      must still replicate every commit the writer completed; also records
//      whether a sidecar spawned by the dead parent is left running.
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";

const ITER = Number(Deno.args[0] ?? 30);
const target = Deno.args[1] ?? "file";
const [kind, port] = target.split(":");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(tag: string) {
  const d = L.tmpdir(`crash-${tag}`);
  const dbPath = join(d, "commits.db");
  const sock = L.sockPath(d);
  const prefix = `swamp-prefix/_litestream/${crypto.randomUUID()}`;
  const spec: L.ReplicaSpec = kind === "file"
    ? { kind: "file", path: join(d, "replica") }
    : { kind: "s3", bucket: "lsbucket", path: prefix, endpoint: `http://localhost:${port}` };
  const env: Record<string, string> = kind === "s3"
    ? { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" }
    : {};
  const cfg = L.writeConfig(d, dbPath, spec, { socket: sock });
  return { d, dbPath, sock, cfg, env };
}

async function writeUntil(
  s: ReturnType<typeof setup>,
  db: ReturnType<typeof L.openWriter>,
  deadline: number,
) {
  let last = 0, confirmed = 0, n = 0;
  while (performance.now() < deadline) {
    last = L.insertCommit(db, 1024);
    if (++n % 7 === 0) {
      const r = await L.syncWait(s.sock, s.dbPath, 5).catch(() => null);
      if (r?.status === 200 && r.json.status === "synced") confirmed = last;
    }
    if (n % 3 === 0) await sleep(1);
  }
  return { last, confirmed };
}

const A: { lost: number; ok: boolean }[] = [];
const B: { ok: boolean }[] = [];
for (let i = 0; i < ITER; i++) {
  // A
  {
    const s = setup("a");
    const db = L.openWriter(s.dbPath, { appAutoCheckpoint: 1000 });
    const p = L.startReplicate(s.cfg, s.env);
    await L.waitReady(s.sock);
    const killAt = performance.now() + 200 + Math.random() * 1300;
    const { last, confirmed } = await writeUntil(s, db, killAt);
    await L.stop(p, "SIGKILL");
    db.close();
    const out = join(s.d, "restored.db");
    let v = { integrity: "none", n: 0, maxSeq: 0 };
    try {
      await L.restore(s.cfg, s.dbPath, out, s.env);
      v = L.verifyRestored(out);
    } catch { /* nothing replicated yet */ }
    const prefixOk = v.n === v.maxSeq && (v.n === 0 || v.integrity === "ok");
    A.push({ lost: last - v.maxSeq, ok: prefixOk && v.maxSeq >= confirmed });
  }
  // B
  {
    const s = setup("b");
    const db = L.openWriter(s.dbPath, { appAutoCheckpoint: 1000 });
    let p = L.startReplicate(s.cfg, s.env);
    await L.waitReady(s.sock);
    const { last } = await writeUntil(s, db, performance.now() + 200 + Math.random() * 1300);
    await L.stop(p, "SIGKILL");
    for (let k = 0; k < 50; k++) L.insertCommit(db, 1024); // writes while replicator is down
    p = L.startReplicate(s.cfg, s.env);
    await L.waitReady(s.sock);
    const r = await L.syncWait(s.sock, s.dbPath);
    await L.stop(p, "SIGTERM");
    db.close();
    const out = join(s.d, "restored.db");
    await L.restore(s.cfg, s.dbPath, out, s.env);
    const v = L.verifyRestored(out);
    B.push({ ok: r.json.status === "synced" && v.integrity === "ok" && v.maxSeq === last + 50 && v.n === last + 50 });
  }
}

// C: writer child killed mid-loop; litestream keeps running in this process.
const C: { ok: boolean; childCommitted: number; replicated: number }[] = [];
let orphanSurvived: boolean | null = null;
for (let i = 0; i < Math.min(ITER, 10); i++) {
  const s = setup("c");
  L.openWriter(s.dbPath, { appAutoCheckpoint: 1000 }).close();
  const p = L.startReplicate(s.cfg, s.env);
  await L.waitReady(s.sock);
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./crash_writer.ts", import.meta.url).pathname, s.dbPath],
    stdout: "null", stderr: "null",
  }).spawn();
  await sleep(300 + Math.random() * 700);
  child.kill("SIGKILL");
  await child.status;
  const local = L.verifyRestored(s.dbPath);
  const r = await L.syncWait(s.sock, s.dbPath);
  await L.stop(p, "SIGTERM");
  const out = join(s.d, "restored.db");
  await L.restore(s.cfg, s.dbPath, out, s.env);
  const v = L.verifyRestored(out);
  C.push({ ok: r.status === 200 && v.integrity === "ok" && v.maxSeq === local.maxSeq, childCommitted: local.maxSeq, replicated: v.maxSeq });
}
// Orphan check: a parent that spawned litestream is SIGKILLed; is the sidecar left behind?
{
  const s = setup("orphan");
  L.openWriter(s.dbPath, { appAutoCheckpoint: 1000 }).close();
  const parent = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./orphan_parent.ts", import.meta.url).pathname, s.cfg, s.sock],
    env: { LITESTREAM_BIN: L.LITESTREAM }, stdout: "piped", stderr: "null",
  }).spawn();
  const reader = parent.stdout.getReader();
  const { value } = await reader.read();
  const childPid = Number(new TextDecoder().decode(value).trim());
  parent.kill("SIGKILL");
  await parent.status;
  await sleep(500);
  try {
    Deno.kill(childPid, "SIGTERM");
    orphanSurvived = true;
  } catch {
    orphanSurvived = false;
  }
  reader.releaseLock();
}

const lost = A.map((a) => a.lost);
console.log(JSON.stringify({
  target, iterations: ITER, os: Deno.build.os, arch: Deno.build.arch,
  A_machineLoss: { invariantHeld: A.filter((a) => a.ok).length, of: A.length, unconfirmedLost: L.stats(lost) },
  B_replicatorKilledRestarted: { fullyReplicated: B.filter((b) => b.ok).length, of: B.length },
  C_writerKilled: { fullyReplicated: C.filter((c) => c.ok).length, of: C.length, sample: C.slice(0, 3) },
  sidecarOrphanSurvivesParentKill: orphanSurvived,
}));
