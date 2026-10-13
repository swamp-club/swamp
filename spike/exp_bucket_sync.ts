// swamp-club#3357 Q1: forced sync through the bucket-latency model.
// Usage: exp_bucket_sync.ts <profile> <creds: static|identity|sso|none> [runs]
//
// cold: per command — spawn the sidecar, wait for the socket, write N commits,
//       POST /sync {wait:true}, SIGTERM. A fresh process each run, so a fresh
//       connection pool and a fresh credential resolution.
// warm: one long-lived sidecar; write N commits, POST /sync {wait:true}.
// N is 1 (one commit) and 50 (a burst, one sync).
// The first run of each series (Litestream's first snapshot to an empty
// replica path) is reported on its own.
import { join } from "jsr:@std/path@1";
import * as L from "./lib.ts";
import * as M from "./model.ts";

const [profileName, credsName, runsStr] = Deno.args;
const profile = M.PROFILES[profileName];
if (!profile) throw new Error(`unknown profile ${profileName}`);
const RUNS = Number(runsStr ?? 30);
const useCreds = profile.backend === "s3" && credsName !== "none";

const proxy = await M.startProxy(profile);
const creds = useCreds ? await M.startCreds(M.CREDS[credsName]) : undefined;
const env = M.cleanEnv(profile.backend, proxy.port, creds?.port);
const load = await M.waitQuiet();

interface Run {
  ready?: number;
  sync: number;
  stop?: number;
  total: number;
  requests: number;
  connections: number;
  bytesUp: number;
  credsHits: number;
  ops: Record<string, number>;
}

async function series(mode: "cold" | "warm", commits: number) {
  const d = L.tmpdir(`3357-${mode}${commits}`);
  const dbPath = join(d, "commits.db");
  const sock = L.sockPath(d);
  const path = `swamp-3357/_litestream/${crypto.randomUUID()}`;
  const cfg = L.writeConfig(d, dbPath, M.replicaSpec(profile.backend, proxy.port, path), {
    socket: sock,
  });
  const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
  const runs: Run[] = [];
  let last = 0;
  let warm: Deno.ChildProcess | undefined;
  for (let i = 0; i <= RUNS; i++) {
    const hits0 = creds ? await creds.hits() : 0;
    await proxy.reset();
    const t0 = performance.now();
    let ready: number | undefined;
    let cold: Deno.ChildProcess | undefined;
    if (mode === "cold" || warm === undefined) {
      const p = L.startReplicate(cfg, env);
      ready = await L.waitReady(sock);
      if (mode === "warm") warm = p;
      else cold = p;
    }
    for (let k = 0; k < commits; k++) last = L.insertCommit(db, 2048);
    const t1 = performance.now();
    const s = await L.syncWait(sock, dbPath);
    if (s.status !== 200 || s.json.status !== "synced") {
      throw new Error(`sync: ${JSON.stringify(s)}`);
    }
    const t2 = performance.now();
    let stop: number | undefined;
    if (cold) stop = (await L.stop(cold, "SIGTERM")).ms;
    const st = await proxy.stats();
    runs.push({
      ready,
      sync: t2 - t1,
      stop,
      total: performance.now() - t0,
      requests: st.requests,
      connections: st.connections,
      bytesUp: st.bytesUp,
      credsHits: creds ? (await creds.hits()) - hits0 : 0,
      ops: st.ops,
    });
    if (mode === "warm") await new Promise((r) => setTimeout(r, 250));
  }
  if (warm) await L.stop(warm, "SIGTERM");
  db.close();
  // The replica must hold the last acknowledged commit.
  const out = join(d, "restored.db");
  await L.restore(cfg, dbPath, out, env);
  const v = L.verifyRestored(out);
  if (v.integrity !== "ok" || v.maxSeq < last) {
    throw new Error(`replica missing commits: ${JSON.stringify(v)} last=${last}`);
  }
  const [first, ...rest] = runs;
  const pick = (k: keyof Run) =>
    M.summary(rest.map((r) => r[k]).filter((x): x is number => typeof x === "number"));
  return {
    mode,
    commits,
    first,
    ready: pick("ready"),
    sync: pick("sync"),
    stop: pick("stop"),
    total: pick("total"),
    requests: pick("requests"),
    connections: pick("connections"),
    bytesUp: pick("bytesUp"),
    credsHits: pick("credsHits"),
    opsLast: rest[rest.length - 1].ops,
    // Uploads a stopping sidecar abandoned mid-body; the proxy refuses them,
    // as a real bucket would (see bucket_proxy.ts).
    abortedUploads: runs.reduce((a, r) => a + (r.ops.ABORTED ?? 0), 0),
    replicaVerified: v,
  };
}

const results = [];
for (const mode of ["cold", "warm"] as const) {
  for (const commits of [1, 50]) results.push(await series(mode, commits));
}
const row = {
  exp: "bucket-sync",
  profile,
  creds: useCreds ? { name: credsName, delayMs: M.CREDS[credsName] } : { name: "none" },
  runs: RUNS,
  loadAtStart: load,
  litestream: "0.5.17",
  at: new Date().toISOString(),
  results,
};
M.appendResult("bucket-sync-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));
await proxy.stop();
await creds?.stop();
