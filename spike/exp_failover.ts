// Q6: restore time/correctness, follow-mode warm standby, and how leader
// fences map onto replica paths. Usage: exp_failover.ts <target> <sizesMB,...>
//   target: file | s3:<port>
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";

const target = Deno.args[0] ?? "file";
const sizes = (Deno.args[1] ?? "1,100").split(",").map(Number);
const [kind, port] = target.split(":");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env: Record<string, string> = kind === "s3"
  ? { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" }
  : {};
const root = L.tmpdir(`fo-${kind}`);
const replicaRoot = `swamp-prefix/_litestream/${crypto.randomUUID()}`;
function spec(name: string): L.ReplicaSpec {
  return kind === "file"
    ? { kind: "file", path: join(root, "replicas", name) }
    : { kind: "s3", bucket: "lsbucket", path: `${replicaRoot}/${name}`, endpoint: `http://localhost:${port}` };
}
function node(name: string, replicaName: string) {
  const d = join(root, name);
  Deno.mkdirSync(d, { recursive: true });
  const dbPath = join(d, "commits.db");
  const sock = L.sockPath(d);
  const cfg = L.writeConfig(d, dbPath, spec(replicaName), { socket: sock });
  return { d, dbPath, sock, cfg };
}
async function fill(db: ReturnType<typeof L.openWriter>, mb: number) {
  const rows = Math.ceil((mb * 1024 * 1024) / 4096);
  for (let i = 0; i < rows; i += 1000) {
    db.exec("BEGIN");
    for (let k = 0; k < 1000 && i + k < rows; k++) L.insertCommit(db, 4000);
    db.exec("COMMIT");
  }
  return rows;
}

const restoreRows: Record<string, unknown>[] = [];
for (const mb of sizes) {
  const a = node(`size-${mb}`, `size-${mb}`);
  const db = L.openWriter(a.dbPath, { appAutoCheckpoint: 1000 });
  const p = L.startReplicate(a.cfg, env);
  await L.waitReady(a.sock);
  const rows = await fill(db, mb);
  const ts = performance.now();
  await L.syncWait(a.sock, a.dbPath, 600);
  const syncMs = performance.now() - ts;
  await L.stop(p, "SIGTERM");
  db.close();
  const out = join(root, `restored-${mb}.db`);
  const ms = await L.restore(a.cfg, a.dbPath, out, env);
  const v = L.verifyRestored(out);
  restoreRows.push({ mb, dbBytes: Deno.statSync(a.dbPath).size, rows, initialSyncMs: Math.round(syncMs), restoreMs: Math.round(ms), ok: v.integrity === "ok" && v.n === rows });
  Deno.removeSync(out);
}

// Follow mode: a standby keeps a hot copy with `restore -f`.
const follow: Record<string, unknown> = {};
{
  const a = node("leader-follow", "follow");
  const db = L.openWriter(a.dbPath, { appAutoCheckpoint: 1000 });
  const p = L.startReplicate(a.cfg, env);
  await L.waitReady(a.sock);
  await fill(db, 20);
  await L.syncWait(a.sock, a.dbPath);
  const standby = join(root, "standby.db");
  const f = new Deno.Command(L.LITESTREAM, {
    args: ["restore", "-config", a.cfg, "-f", "-follow-interval", "200ms", "-o", standby, a.dbPath],
    env, stdout: "null", stderr: "null",
  }).spawn();
  let last = 0;
  const lags: number[] = [];
  for (let i = 0; i < 10; i++) {
    last = L.insertCommit(db, 4000);
    await L.syncWait(a.sock, a.dbPath);
    const t = performance.now();
    while (true) {
      try {
        if (L.verifyRestored(standby).maxSeq >= last) break;
      } catch { /* standby not there yet */ }
      if (performance.now() - t > 30000) throw new Error("follow lag > 30s");
      await sleep(20);
    }
    lags.push(performance.now() - t);
  }
  f.kill("SIGTERM");
  await f.status;
  await L.stop(p, "SIGTERM");
  db.close();
  const v = L.verifyRestored(standby);
  Object.assign(follow, { replicatedToStandbyAfterSyncMs: L.stats(lags), standbyIntegrity: v.integrity, standbyMatches: v.maxSeq === last });
}

// Failover: same path vs path per fence, and a zombie old leader.
const failover: Record<string, unknown> = {};
for (const mode of ["same-path", "path-per-fence"] as const) {
  const a = node(`${mode}-a`, `${mode}-fence-1`);
  const dbA = L.openWriter(a.dbPath, { appAutoCheckpoint: 1000 });
  const pA = L.startReplicate(a.cfg, env);
  await L.waitReady(a.sock);
  await fill(dbA, 20);
  const lastA = L.insertCommit(dbA, 4000);
  await L.syncWait(a.sock, a.dbPath);
  // B takes over: restore from A's replica, then replicate.
  const b = node(`${mode}-b`, mode === "same-path" ? `${mode}-fence-1` : `${mode}-fence-2`);
  const t0 = performance.now();
  await L.restore(a.cfg, a.dbPath, b.dbPath, env);
  const restoreMs = performance.now() - t0;
  const dbB = L.openWriter(b.dbPath, { appAutoCheckpoint: 1000 });
  const pB = L.startReplicate(b.cfg, env);
  await L.waitReady(b.sock);
  const t1 = performance.now();
  const firstSync = await L.syncWait(b.sock, b.dbPath, 120);
  const firstSyncMs = performance.now() - t1;
  // Zombie: A keeps writing to its own path while B writes too.
  for (let i = 0; i < 200; i++) { L.insertCommit(dbA, 4000); L.insertCommit(dbB, 4000); }
  const zA = await L.syncWait(a.sock, a.dbPath).catch((e) => ({ status: 0, json: { error: String(e) } }));
  const zB = await L.syncWait(b.sock, b.dbPath).catch((e) => ({ status: 0, json: { error: String(e) } }));
  const lastB = (dbB.prepare("SELECT max(seq) AS m FROM commits").get() as { m: number }).m;
  await L.stop(pA, "SIGTERM");
  await L.stop(pB, "SIGTERM");
  dbA.close();
  dbB.close();
  // A fresh node restores from B's path: does it get B's history exactly?
  const out = join(root, `${mode}-c.db`);
  let v: unknown;
  try {
    await L.restore(b.cfg, b.dbPath, out, env);
    const r = L.verifyRestored(out);
    v = { ...r, matchesB: r.maxSeq === lastB && r.n === lastB, lastA, lastB };
  } catch (e) {
    v = { error: (e as Error).message.slice(0, 300) };
  }
  failover[mode] = {
    restoreMs: Math.round(restoreMs), firstSyncAfterTakeover: { ms: Math.round(firstSyncMs), ...firstSync.json },
    zombieSyncA: zA.json, zombieSyncB: zB.json, restoreFromBPath: v,
  };
}

console.log(JSON.stringify({ target, os: Deno.build.os, arch: Deno.build.arch, restore: restoreRows, follow, failover }));
