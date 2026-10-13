// swamp-club#3357: what an uncompacted per-command replica costs at restore,
// and whether a later long-lived sidecar compacts what per-command runs left.
// Usage: exp_restore_objects.ts <commitsDb> <replicaPath> [runs]
//   commitsDb    the per-command growth run's commits.db (its local
//                .commits.db-litestream state beside it)
//   replicaPath  that run's replica path in bucket lsbucket on ministack
// Env: LITESTREAM_BIN.
import { join } from "jsr:@std/path@1";
import * as L from "./lib.ts";
import * as M from "./model.ts";

const [dbPath, replicaPath, runsStr] = Deno.args;
const RUNS = Number(runsStr ?? 5);
const root = L.tmpdir("3357-restore-objects");

async function objects(): Promise<{ count: number; levels: Record<string, number> }> {
  let count = 0, token: string | undefined;
  const levels: Record<string, number> = {};
  do {
    const u = new URL(`${M.EMULATOR.s3}/${M.BUCKET}`);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", replicaPath + "/");
    if (token) u.searchParams.set("continuation-token", token);
    const xml = await (await fetch(u)).text();
    for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
      count++;
      const lvl = m[1].slice(replicaPath.length + 1).split("/")[0];
      levels[lvl] = (levels[lvl] ?? 0) + 1;
    }
    token = xml.match(/<NextContinuationToken>([^<]*)</)?.[1];
  } while (token);
  return { count, levels };
}

async function restores(label: string) {
  const out: Record<string, unknown> = { label, objects: await objects() };
  for (const name of ["s3-near", "s3-far"]) {
    const proxy = await M.startProxy(M.PROFILES[name]);
    const env = M.cleanEnv("s3", proxy.port);
    const d = join(root, `${label}-${name}`);
    Deno.mkdirSync(d, { recursive: true });
    const cfg = L.writeConfig(d, join(d, "src.db"), M.replicaSpec("s3", proxy.port, replicaPath), {
      socket: L.sockPath(d),
    });
    const times: number[] = [], reqs: number[] = [];
    let ok = 0;
    for (let i = 0; i < RUNS; i++) {
      const o = join(d, `r-${i}.db`);
      await proxy.reset();
      times.push(await L.restore(cfg, join(d, "src.db"), o, env));
      reqs.push((await proxy.stats()).requests);
      const v = L.verifyIntegrity(o);
      if (v === "ok") ok++;
    }
    out[name] = { restoreMs: M.summary(times), requests: M.summary(reqs), integrity: `${ok}/${RUNS}` };
    await proxy.stop();
  }
  console.error(JSON.stringify(out));
  return out;
}

const before = await restores("uncompacted");

// A long-lived sidecar on the same database and replica path, for longer
// than L0 retention (5 min), straight to the emulator.
const d = join(root, "compact");
Deno.mkdirSync(d, { recursive: true });
const sock = L.sockPath(d);
const cfg = L.writeConfig(d, dbPath, {
  kind: "s3",
  bucket: M.BUCKET,
  path: replicaPath,
  endpoint: M.EMULATOR.s3,
}, { socket: sock });
const env = M.cleanEnv("s3", 0);
const p = L.startReplicate(cfg, env);
await L.waitReady(sock);
await L.syncWait(sock, dbPath);
const t0 = performance.now();
await new Promise((r) => setTimeout(r, 340_000));
await L.stop(p, "SIGTERM");
const after = await restores("after-long-lived-sidecar");

const row = {
  exp: "restore-objects",
  replicaPath,
  longLivedSidecarS: Math.round((performance.now() - t0) / 1000),
  before,
  after,
  at: new Date().toISOString(),
};
M.appendResult("restore-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));
