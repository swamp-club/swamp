// swamp-club#3357 Q3: restore time and follow-mode lag through the
// bucket-latency model (throughput cap included).
// Usage: exp_restore.ts <profile> <creds: static|identity|sso|none> <sizesMB,...> <runs> [bigRuns]
// Sizes of 1000 MB and over use bigRuns (default 10).
import { join } from "jsr:@std/path@1";
import * as L from "./lib.ts";
import * as M from "./model.ts";

const [profileName, credsName, sizesStr, runsStr, bigRunsStr] = Deno.args;
const profile = M.PROFILES[profileName];
if (!profile) throw new Error(`unknown profile ${profileName}`);
const sizes = sizesStr.split(",").map(Number);
const RUNS = Number(runsStr ?? 20), BIG_RUNS = Number(bigRunsStr ?? 10);
const useCreds = profile.backend === "s3" && credsName !== "none";
const proxy = await M.startProxy(profile);
const creds = useCreds ? await M.startCreds(M.CREDS[credsName]) : undefined;
const env = M.cleanEnv(profile.backend, proxy.port, creds?.port);
const root = L.tmpdir("3357-restore");
const tag = crypto.randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function node(name: string) {
  const d = join(root, name);
  Deno.mkdirSync(d, { recursive: true });
  const dbPath = join(d, "commits.db");
  const sock = L.sockPath(d);
  const cfg = L.writeConfig(
    d,
    dbPath,
    M.replicaSpec(profile.backend, proxy.port, `swamp-3357-restore-${tag}/${name}`),
    { socket: sock },
  );
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

const load = await M.waitQuiet();
const restore: Record<string, unknown>[] = [];
for (const mb of sizes) {
  const a = node(`size-${mb}`);
  const db = L.openWriter(a.dbPath, { appAutoCheckpoint: 1000 });
  const p = L.startReplicate(a.cfg, env);
  await L.waitReady(a.sock);
  const rows = await fill(db, mb);
  const ts = performance.now();
  await L.syncWait(a.sock, a.dbPath, 3600);
  const initialSyncMs = performance.now() - ts;
  await L.stop(p, "SIGTERM");
  db.close();
  const n = mb >= 1000 ? BIG_RUNS : RUNS;
  const times: number[] = [];
  const reqs: number[] = [];
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const out = join(root, `restored-${mb}-${i}.db`);
    await proxy.reset();
    times.push(await L.restore(a.cfg, a.dbPath, out, env));
    reqs.push((await proxy.stats()).requests);
    const v = L.verifyRestored(out);
    if (v.integrity === "ok" && v.n === rows) ok++;
    Deno.removeSync(out);
  }
  restore.push({
    mb,
    dbBytes: Deno.statSync(a.dbPath).size,
    rows,
    initialSyncMs: Math.round(initialSyncMs),
    restoreMs: M.summary(times),
    requests: M.summary(reqs),
    verified: `${ok}/${n}`,
  });
  console.error(JSON.stringify(restore[restore.length - 1]));
}

// Follow mode: a standby runs `restore -f`; lag from the leader's
// acknowledged sync to the standby holding the commit.
const follow: Record<string, unknown> = {};
for (const interval of ["200ms", "1s"]) {
  const a = node(`follow-${interval}`);
  const db = L.openWriter(a.dbPath, { appAutoCheckpoint: 1000 });
  const p = L.startReplicate(a.cfg, env);
  await L.waitReady(a.sock);
  await fill(db, 20);
  await L.syncWait(a.sock, a.dbPath, 600);
  const standby = join(root, `standby-${interval}.db`);
  const f = new Deno.Command(L.LITESTREAM, {
    args: ["restore", "-config", a.cfg, "-f", "-follow-interval", interval, "-o", standby, a.dbPath],
    env,
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).spawn();
  let last = 0;
  const lags: number[] = [];
  for (let i = 0; i <= RUNS; i++) {
    last = L.insertCommit(db, 4000);
    await L.syncWait(a.sock, a.dbPath);
    const t = performance.now();
    while (true) {
      try {
        if (L.verifyRestored(standby).maxSeq >= last) break;
      } catch { /* standby not there yet */ }
      if (performance.now() - t > 60000) throw new Error("follow lag > 60s");
      await sleep(10);
    }
    // The first sample includes the standby's initial restore.
    if (i > 0) lags.push(performance.now() - t);
    await sleep(100);
  }
  f.kill("SIGTERM");
  await f.status;
  await L.stop(p, "SIGTERM");
  db.close();
  const v = L.verifyRestored(standby);
  follow[interval] = {
    lagAfterAckMs: M.summary(lags),
    standbyIntegrity: v.integrity,
    standbyMatches: v.maxSeq === last,
  };
}

const row = {
  exp: "restore",
  profile,
  creds: useCreds ? { name: credsName, delayMs: M.CREDS[credsName] } : { name: "none" },
  loadAtStart: load,
  at: new Date().toISOString(),
  restore,
  follow,
};
M.appendResult("restore-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));
await proxy.stop();
await creds?.stop();
