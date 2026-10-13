// Q2: checkpoint regimes. Usage: deno run -A exp_compat.ts <regime> [commits]
// regimes: passive-default | auto-off | app-truncate | app-restart
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const regime = Deno.args[0];
const N = Number(Deno.args[1] ?? 20000);
const d = L.tmpdir(`compat-${regime}`);
const dbPath = join(d, "commits.db");
const db = L.openWriter(dbPath, {
  appAutoCheckpoint: regime === "passive-default" ? 1000 : 0,
});
const sock = L.sockPath(d);
const replica = join(d, "replica");
const cfg = L.writeConfig(d, dbPath, { kind: "file", path: replica }, { socket: sock });
const p = L.startReplicate(cfg);
await L.waitReady(sock);
let confirmed = 0;
const appCkpt: { busy: number; log: number; checkpointed: number }[] = [];
let maxWal = 0;
for (let i = 1; i <= N; i++) {
  const seq = L.insertCommit(db, 2048);
  if (i % 500 === 0) {
    if (regime === "app-truncate" || regime === "app-restart") {
      const mode = regime === "app-truncate" ? "TRUNCATE" : "RESTART";
      appCkpt.push(db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as never);
    }
    try { maxWal = Math.max(maxWal, Deno.statSync(dbPath + "-wal").size); } catch { /* */ }
    const r = await L.syncWait(sock, dbPath);
    if (r.status === 200) confirmed = seq;
  }
}
const final = await L.syncWait(sock, dbPath);
if (final.status === 200) confirmed = N;
const diag = (await L.control(sock, "GET", `/debug/sync-status?path=${encodeURIComponent(dbPath)}`)).json;
await L.stop(p, "SIGTERM");
db.close();
const out = join(d, "restored.db");
const ms = await L.restore(cfg, dbPath, out);
const v = L.verifyRestored(out);
let replicaBytes = 0, replicaFiles = 0;
const levels: Record<string, number> = {};
const walk = (dir: string) => { for (const e of Deno.readDirSync(dir)) { const f = join(dir, e.name); if (e.isDirectory) walk(f); else { replicaFiles++; replicaBytes += Deno.statSync(f).size; const m = f.match(/ltx\/(\d+)\//); if (m) levels[m[1]] = (levels[m[1]] ?? 0) + 1; } } };
walk(replica);
const busyCkpts = appCkpt.filter((c) => c.busy).length;
const partial = appCkpt.filter((c) => c.checkpointed < c.log).length;
console.log(JSON.stringify({
  regime, commits: N, confirmed, restored: v, restoreMs: Math.round(ms),
  correct: v.integrity === "ok" && v.n === N && v.maxSeq === N,
  maxWalBytes: maxWal, replicaBytes, replicaFiles, levels, dbBytes: Deno.statSync(dbPath).size,
  appCheckpoints: appCkpt.length, appCheckpointsBusy: busyCkpts, appCheckpointsPartial: partial,
}));
