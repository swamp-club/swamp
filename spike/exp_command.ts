// swamp-club#3357 Q2: whole write commands, v3 + Litestream against v2 push,
// through the bucket-latency model.
// Usage: exp_command.ts <profile> <creds: static|identity|sso|none> [runs]
// Env: SWAMP_BIN (spike binary), LITESTREAM_BIN.
//
// Variants, each in its own scratch repo:
//   v3-floor       filesystem-v3, no replication
//   v3-percommand  filesystem-v3, sidecar per command, one forced sync
//   v3-idle        filesystem-v3, idle sidecar reused through a pidfile
//   v2             @swamp/s3-datastore or @swamp/gcs-datastore, push per command
// Ops: small (about 1 KB output), large (about 10 MB), delete (data delete).
//
// The filesystem-v3 prototype keeps chunks on local disk, while Phase 4 puts
// them in the bucket through storage/1 before the commit. So for each v3 run
// the new chunk files under _blobs/ are PUT through the same proxy
// (concurrency 8) and timed; `chunksMs` is that, and `v3Modelled` is the
// v3 time plus it, in series (chunks, then commit, then sync).
import { join } from "jsr:@std/path@1";
import * as M from "./model.ts";

const [profileName, credsName, runsStr] = Deno.args;
const profile = M.PROFILES[profileName];
if (!profile) throw new Error(`unknown profile ${profileName}`);
const RUNS = Number(runsStr ?? 20);
const SWAMP = Deno.env.get("SWAMP_BIN")!;
const LITESTREAM = Deno.env.get("LITESTREAM_BIN")!;
const useCreds = profile.backend === "s3" && credsName !== "none";

const proxy = await M.startProxy(profile);
const creds = useCreds ? await M.startCreds(M.CREDS[credsName]) : undefined;
const root = Deno.makeTempDirSync({ prefix: "ls3357-cmd-" });
const tag = crypto.randomUUID().slice(0, 8);

function baseEnv(): Record<string, string> {
  return {
    ...M.cleanEnv(profile.backend, proxy.port, creds?.port),
    SWAMP_NO_TELEMETRY: "1",
    SWAMP_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
}

async function swamp(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<number> {
  const t0 = performance.now();
  const r = await new Deno.Command(SWAMP, {
    args,
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const ms = performance.now() - t0;
  if (!r.success) {
    throw new Error(
      `swamp ${args.join(" ")} failed in ${cwd}:\n` +
        new TextDecoder().decode(r.stderr).slice(-2000) +
        new TextDecoder().decode(r.stdout).slice(-2000),
    );
  }
  return ms;
}

function shellModel(name: string, id: string, run: string): string {
  return [
    "type: command/shell",
    "typeVersion: 2026.02.09.1",
    `id: ${id}`,
    `name: ${name}`,
    "version: 1",
    "tags: {}",
    "globalArguments: {}",
    "methods:",
    "  execute:",
    "    arguments:",
    `      run: "${run}"`,
    "",
  ].join("\n");
}

type Variant = "v3-floor" | "v3-percommand" | "v3-idle" | "v2";

interface Repo {
  variant: Variant;
  dir: string;
  ds?: string;
  env: Record<string, string>;
}

async function makeRepo(variant: Variant): Promise<Repo> {
  const dir = join(root, variant, "repo");
  Deno.mkdirSync(dir, { recursive: true });
  const env = baseEnv();
  await swamp(dir, ["repo", "init", "--tool", "none"], env);
  let ds: string | undefined;
  if (variant === "v2") {
    const ext = profile.backend === "s3" ? "@swamp/s3-datastore" : "@swamp/gcs-datastore";
    await swamp(dir, ["extension", "pull", ext], env);
    const prefix = `swamp-3357-v2-${tag}`;
    const config = profile.backend === "s3"
      ? {
        bucket: M.BUCKET,
        prefix,
        region: "us-east-1",
        endpoint: `http://localhost:${proxy.port}`,
        forcePathStyle: true,
      }
      : {
        bucket: M.BUCKET,
        prefix,
        projectId: "test",
        apiEndpoint: `http://localhost:${proxy.port}`,
      };
    await swamp(dir, ["datastore", "setup", "extension", ext, "--config", JSON.stringify(config)], env);
  } else {
    ds = join(root, variant, "ds");
    await swamp(dir, ["datastore", "setup", "filesystem", "--path", ds, "--format", "3"], env);
    if (variant !== "v3-floor") {
      const replica = profile.backend === "s3"
        ? {
          type: "s3",
          bucket: M.BUCKET,
          path: `swamp-3357-v3-${tag}/${variant}/_litestream/1`,
          endpoint: `http://localhost:${proxy.port}`,
        }
        : { type: "gs", bucket: M.BUCKET, path: `swamp-3357-v3-${tag}/${variant}/_litestream/1` };
      env.SWAMP_SPIKE_LITESTREAM = variant === "v3-idle" ? "idle" : "percommand";
      env.SWAMP_SPIKE_LITESTREAM_BIN = LITESTREAM;
      env.SWAMP_SPIKE_LITESTREAM_REPLICA = JSON.stringify(replica);
      env.SWAMP_SPIKE_LITESTREAM_IDLE_S = "60";
      env.SWAMP_SPIKE_LITESTREAM_LOG = join(root, variant, "spike.jsonl");
    }
  }
  const mdir = join(dir, "models", "command", "shell");
  Deno.mkdirSync(mdir, { recursive: true });
  Deno.writeTextFileSync(
    join(mdir, "small.yaml"),
    shellModel("small", crypto.randomUUID(), "head -c 768 /dev/urandom | base64"),
  );
  Deno.writeTextFileSync(
    join(mdir, "large.yaml"),
    shellModel("large", crypto.randomUUID(), "head -c 7864320 /dev/urandom | base64"),
  );
  return { variant, dir, ds, env };
}

/** Lists _blobs files with their sizes. */
function blobs(ds: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string) => {
    for (const e of Deno.readDirSync(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) walk(p);
      else if (e.isFile) out.set(p, Deno.statSync(p).size);
    }
  };
  try {
    walk(join(ds, "_blobs"));
  } catch { /* none yet */ }
  return out;
}

/** PUTs the given files through the proxy, 8 at a time; returns ms. */
async function putChunks(files: string[]): Promise<number> {
  const t0 = performance.now();
  const queue = [...files];
  const worker = async () => {
    while (queue.length > 0) {
      const f = queue.shift()!;
      const body = await Deno.readFile(f);
      const key = `swamp-3357-chunks-${tag}/${crypto.randomUUID()}`;
      const url = profile.backend === "s3"
        ? `http://localhost:${proxy.port}/${M.BUCKET}/${key}`
        : `http://localhost:${proxy.port}/upload/storage/v1/b/${M.BUCKET}/o?uploadType=media&name=${encodeURIComponent(key)}`;
      const r = await fetch(url, {
        method: profile.backend === "s3" ? "PUT" : "POST",
        body,
      });
      await r.body?.cancel();
      if (!r.ok) throw new Error(`chunk PUT ${r.status}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
  return files.length === 0 ? 0 : performance.now() - t0;
}

interface Sample {
  ms: number;
  bytesUp: number;
  requests: number;
  connections: number;
  credsHits: number;
  chunkFiles?: number;
  chunkBytes?: number;
  chunksMs?: number;
}

async function timed(repo: Repo, args: string[]): Promise<Sample> {
  const before = repo.ds ? blobs(repo.ds) : undefined;
  const hits0 = creds ? await creds.hits() : 0;
  await proxy.reset();
  const ms = await swamp(repo.dir, args, repo.env);
  const st = await proxy.stats();
  const s: Sample = {
    ms,
    bytesUp: st.bytesUp,
    requests: st.requests,
    connections: st.connections,
    credsHits: creds ? (await creds.hits()) - hits0 : 0,
  };
  if (repo.ds && before) {
    const after = blobs(repo.ds);
    const added = [...after.keys()].filter((k) => !before.has(k));
    s.chunkFiles = added.length;
    s.chunkBytes = added.reduce((a, k) => a + after.get(k)!, 0);
    s.chunksMs = await putChunks(added);
  }
  return s;
}

const OPS: Record<string, string[]> = {
  small: ["model", "method", "run", "small", "execute"],
  large: ["model", "method", "run", "large", "execute"],
  delete: ["data", "delete", "small", "log", "--yes"],
};

const load = await M.waitQuiet();
const variants: Variant[] = ["v3-floor", "v3-percommand", "v3-idle", "v2"];
const repos = await Promise.all(variants.map(makeRepo));
const samples: Record<string, Record<string, Sample[]>> = {};
for (const v of variants) samples[v] = { small: [], large: [], delete: [] };

// Interleave variants inside each iteration, so drift in machine load hits
// all of them alike. Iteration 0 is warm-up (first snapshot, extension
// bundling, first idle-sidecar start) and is reported on its own.
for (let i = 0; i <= RUNS; i++) {
  for (const repo of repos) {
    for (const op of ["small", "delete", "large"]) {
      samples[repo.variant][op].push(await timed(repo, OPS[op]));
    }
  }
}

const summarise = (xs: Sample[]) => {
  const [first, ...rest] = xs;
  const pick = (f: (s: Sample) => number | undefined) =>
    M.summary(rest.map(f).filter((x): x is number => typeof x === "number"));
  return {
    first,
    ms: pick((s) => s.ms),
    bytesUp: pick((s) => s.bytesUp),
    requests: pick((s) => s.requests),
    connections: pick((s) => s.connections),
    credsHits: pick((s) => s.credsHits),
    chunkFiles: pick((s) => s.chunkFiles),
    chunkBytes: pick((s) => s.chunkBytes),
    chunksMs: pick((s) => s.chunksMs),
    modelledMs: pick((s) => s.chunksMs === undefined ? undefined : s.ms + s.chunksMs),
  };
};

const results: Record<string, Record<string, unknown>> = {};
for (const v of variants) {
  results[v] = {};
  for (const op of Object.keys(OPS)) results[v][op] = summarise(samples[v][op]);
  const log = join(root, v, "spike.jsonl");
  try {
    results[v].sidecar = Deno.readTextFileSync(log).trim().split("\n").map((l) => JSON.parse(l))
      .slice(-3);
  } catch { /* v3-floor and v2 have no sidecar */ }
}
const row = {
  exp: "command",
  profile,
  creds: useCreds ? { name: credsName, delayMs: M.CREDS[credsName] } : { name: "none" },
  runs: RUNS,
  loadAtStart: load,
  at: new Date().toISOString(),
  results,
};
M.appendResult("command-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));

// Stop idle sidecars: touch nothing and kill what the pidfiles name.
for (const repo of repos) {
  if (repo.variant !== "v3-idle") continue;
  const dir = join(repo.env.HOME, ".swamp", "spike-litestream");
  for (const e of Deno.readDirSync(dir)) {
    if (!e.name.endsWith(".pid")) continue;
    const pid = Number(Deno.readTextFileSync(join(dir, e.name)).trim());
    if (pid > 0) {
      try {
        Deno.kill(pid, "SIGTERM");
      } catch { /* gone */ }
    }
  }
}
await proxy.stop();
await creds?.stop();
