// Q4/Q5/Q8: per-command overhead, forced-sync cost, passive replication lag.
// Usage: exp_latency.ts <target> [runs]
//   target: file | s3:<port> | gs:<port>   (port may be an rtt_proxy port)
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";

const [target, runsStr] = Deno.args;
const RUNS = Number(runsStr ?? 20);
const [kind, port] = target.split(":");
const d = L.tmpdir(`lat-${kind}`);
const dbPath = join(d, "commits.db");
const sock = L.sockPath(d);
const prefix = `swamp-prefix/_litestream/${crypto.randomUUID()}`;
const spec: L.ReplicaSpec = kind === "file"
  ? { kind: "file", path: join(d, "replica") }
  : kind === "s3"
  ? { kind: "s3", bucket: "lsbucket", path: prefix, endpoint: `http://localhost:${port}` }
  : { kind: "gs", bucket: "lsbucket", path: prefix };
const env: Record<string, string> = kind === "s3"
  ? { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" }
  : kind === "gs"
  ? { STORAGE_EMULATOR_HOST: `localhost:${port}` }
  : {};
const cfg = L.writeConfig(d, dbPath, spec, { socket: sock });
const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });

// --- per-command: spawn, ready, write 5, forced sync, SIGTERM ---------------
const ready: number[] = [], sync: number[] = [], stopMs: number[] = [], total: number[] = [];
let first: Record<string, number> | undefined;
for (let i = 0; i < RUNS; i++) {
  const t0 = performance.now();
  const p = L.startReplicate(cfg, env);
  const r = await L.waitReady(sock);
  for (let k = 0; k < 5; k++) L.insertCommit(db, 2048);
  const t1 = performance.now();
  const s = await L.syncWait(sock, dbPath);
  if (s.status !== 200 || s.json.status !== "synced") throw new Error(JSON.stringify(s));
  const t2 = performance.now();
  const st = await L.stop(p, "SIGTERM");
  const row = { ready: r, sync: t2 - t1, stop: st.ms, total: performance.now() - t0 };
  if (i === 0) first = row;
  else { ready.push(row.ready); sync.push(row.sync); stopMs.push(row.stop); total.push(row.total); }
}

// --- shutdown-only: write, SIGTERM without a forced sync; is it replicated? --
let shutdownOnlyReplicated = 0, shutdownOnlyRuns = 0;
const shutdownStop: number[] = [];
for (let i = 0; i < Math.min(RUNS, 10); i++) {
  const p = L.startReplicate(cfg, env);
  await L.waitReady(sock);
  let last = 0;
  for (let k = 0; k < 5; k++) last = L.insertCommit(db, 2048);
  const st = await L.stop(p, "SIGTERM");
  shutdownStop.push(st.ms);
  shutdownOnlyRuns++;
  const out = join(d, `so-${i}.db`);
  await L.restore(cfg, dbPath, out, env);
  if (L.verifyRestored(out).maxSeq >= last) shutdownOnlyReplicated++;
}

// --- long-lived: forced sync per commit, and passive lag ---------------------
const p = L.startReplicate(cfg, env);
await L.waitReady(sock);
const forced: number[] = [];
for (let i = 0; i < RUNS * 2; i++) {
  L.insertCommit(db, 2048);
  const t = performance.now();
  const s = await L.syncWait(sock, dbPath);
  if (s.json.status !== "synced") throw new Error(JSON.stringify(s));
  forced.push(performance.now() - t);
}
// Passive lag: commit, then poll a non-forcing view of the replica position.
// `/sync` with wait=false would force the local step, so instead read the
// replica's max TXID with `litestream ltx` against the replica.
async function replicaMaxTxid(): Promise<number> {
  const r = await new Deno.Command(L.LITESTREAM, {
    args: ["ltx", "-config", cfg, dbPath], env, stderr: "null",
  }).output();
  const text = new TextDecoder().decode(r.stdout);
  let max = 0;
  for (const m of text.matchAll(/\b([0-9a-f]{16})\b/g)) max = Math.max(max, parseInt(m[1], 16));
  return max;
}
const lag: number[] = [];
for (let i = 0; i < Math.min(RUNS, 10); i++) {
  const before = await replicaMaxTxid();
  L.insertCommit(db, 2048);
  const t = performance.now();
  while ((await replicaMaxTxid()) <= before) {
    if (performance.now() - t > 20000) throw new Error("lag > 20s");
  }
  lag.push(performance.now() - t);
  await new Promise((r) => setTimeout(r, 300));
}
await L.stop(p, "SIGTERM");
db.close();

console.log(JSON.stringify({
  target, runs: RUNS,
  perCommand: { firstRun: first, ready: L.stats(ready), forcedSync: L.stats(sync), stop: L.stats(stopMs), total: L.stats(total) },
  shutdownOnly: { replicated: shutdownOnlyReplicated, runs: shutdownOnlyRuns, stop: L.stats(shutdownStop) },
  longLived: { forcedSyncPerCommit: L.stats(forced), passiveLag: L.stats(lag) },
}));
