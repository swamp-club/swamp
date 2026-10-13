// swamp-club#3357 Q4: replica growth over a day of v3 commits, SQLite's
// default checkpointing, per-command Litestream sidecar on S3 (ministack).
// Bytes and object counts do not depend on latency, so this runs uncapped.
// Usage: exp_growth.ts <label> <modelRuns> <deletes>
// Env: SWAMP_BIN, LITESTREAM_BIN.
//
// The day is a stated count of commands, run back to back: model runs (90%
// with a 1 KB output, 10% with 100 KB) and data deletes spread evenly among
// them. Commits per command are measured from commits.db. Litestream's
// time-based compactions (L1 30 s, L2 5 min, L3 1 h by default) do not fire
// on a compressed timeline, so the replica is also sampled 35 s and 330 s
// after the last command.
import { join } from "jsr:@std/path@1";
import { DatabaseSync } from "node:sqlite";
import * as M from "./model.ts";

const [label, runsStr, deletesStr] = Deno.args;
const RUNS = Number(runsStr), DELETES = Number(deletesStr);
const SWAMP = Deno.env.get("SWAMP_BIN")!;
// GROWTH_MODE: percommand (default) or idle. GROWTH_ORDER: before-close
// (default: sync and stop the sidecar before the stores close) or after-close.
const MODE = Deno.env.get("GROWTH_MODE") ?? "percommand";
const ORDER = Deno.env.get("GROWTH_ORDER") ?? "before-close";
const LITESTREAM = Deno.env.get("LITESTREAM_BIN")!;
const root = Deno.makeTempDirSync({ prefix: "ls3357-growth-" });
const tag = crypto.randomUUID().slice(0, 8);
const prefix = `swamp-3357-growth-${tag}/_litestream/1`;
const repo = join(root, "repo"), ds = join(root, "ds");
Deno.mkdirSync(repo, { recursive: true });

const env: Record<string, string> = {
  ...M.cleanEnv("s3", 0),
  SWAMP_NO_TELEMETRY: "1",
  SWAMP_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
};
async function swamp(args: string[], withSpike = true) {
  const e = { ...env };
  if (withSpike) {
    Object.assign(e, {
      SWAMP_SPIKE_LITESTREAM: MODE,
      SWAMP_SPIKE_LITESTREAM_ORDER: ORDER,
      SWAMP_SPIKE_LITESTREAM_IDLE_S: "600",
      SWAMP_SPIKE_LITESTREAM_BIN: LITESTREAM,
      SWAMP_SPIKE_LITESTREAM_REPLICA: JSON.stringify({
        type: "s3",
        bucket: M.BUCKET,
        path: prefix,
        endpoint: M.EMULATOR.s3,
      }),
    });
  }
  const r = await new Deno.Command(SWAMP, {
    args,
    cwd: repo,
    env: e,
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!r.success) {
    throw new Error(`swamp ${args.join(" ")}: ${new TextDecoder().decode(r.stderr).slice(-1500)}`);
  }
}

await swamp(["repo", "init", "--tool", "none"], false);
await swamp(["datastore", "setup", "filesystem", "--path", ds, "--format", "3"], false);
const mdir = join(repo, "models", "command", "shell");
Deno.mkdirSync(mdir, { recursive: true });
const model = (name: string, bytes: number) =>
  Deno.writeTextFileSync(
    join(mdir, `${name}.yaml`),
    [
      "type: command/shell",
      "typeVersion: 2026.02.09.1",
      `id: ${crypto.randomUUID()}`,
      `name: ${name}`,
      "version: 1",
      "tags: {}",
      "globalArguments: {}",
      "methods:",
      "  execute:",
      "    arguments:",
      `      run: "head -c ${bytes} /dev/urandom | base64"`,
      "",
    ].join("\n"),
  );
model("small", 768);
model("medium", 76800);

const commitsDb = join(ds, "commits.db");
function commitCount(): number {
  try {
    const db = new DatabaseSync(commitsDb, { readOnly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM commits").get() as { n: number }).n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}
function localBytes() {
  const size = (p: string) => {
    try {
      return Deno.statSync(p).size;
    } catch {
      return 0;
    }
  };
  return { db: size(commitsDb), wal: size(commitsDb + "-wal") };
}
async function replica() {
  let bytes = 0, objects = 0, token: string | undefined;
  const levels: Record<string, number> = {};
  do {
    const u = new URL(`${M.EMULATOR.s3}/${M.BUCKET}`);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("prefix", prefix + "/");
    if (token) u.searchParams.set("continuation-token", token);
    const xml = await (await fetch(u)).text();
    for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)) {
      objects++;
      bytes += Number(m[2]);
      const lvl = m[1].slice(prefix.length + 1).split("/").slice(0, 2).join("/");
      levels[lvl] = (levels[lvl] ?? 0) + Number(m[2]);
    }
    token = xml.match(/<NextContinuationToken>([^<]*)</)?.[1];
  } while (token);
  return { bytes, objects, levels };
}

const samples: Record<string, unknown>[] = [];
const perOp: Record<string, number[]> = { small: [], medium: [], delete: [] };
const total = RUNS + DELETES;
const deleteEvery = DELETES > 0 ? Math.floor(total / DELETES) : Infinity;
let runs = 0, deletes = 0;
const t0 = performance.now();
for (let i = 1; i <= total; i++) {
  const before = commitCount();
  let op: string;
  if (deletes < DELETES && i % deleteEvery === 0 && runs > 0) {
    op = "delete";
    await swamp(["data", "delete", "small", "log", "--yes"]).catch(async () => {
      // Nothing to delete yet: make something, then delete it.
      await swamp(["model", "method", "run", "small", "execute"]);
      await swamp(["data", "delete", "small", "log", "--yes"]);
    });
    deletes++;
  } else {
    op = runs % 10 === 9 ? "medium" : "small";
    await swamp(["model", "method", "run", op, "execute"]);
    runs++;
  }
  perOp[op].push(commitCount() - before);
  if (i % 25 === 0 || i === total) {
    samples.push({ commands: i, commits: commitCount(), local: localBytes(), replica: await replica(), elapsedS: Math.round((performance.now() - t0) / 1000) });
    console.error(JSON.stringify(samples[samples.length - 1]));
  }
}
const after: Record<string, unknown> = {};
for (const waitS of Deno.env.get("GROWTH_SKIP_IDLE") ? [] : [35, 330]) {
  const already = Object.keys(after).reduce((a, k) => a + Number(k), 0);
  await new Promise((r) => setTimeout(r, (waitS - already) * 1000));
  after[String(waitS)] = { replica: await replica(), local: localBytes() };
}
const commits = commitCount();
const last = samples[samples.length - 1] as { replica: { bytes: number } };
const row = {
  exp: "growth",
  label,
  mode: MODE,
  order: ORDER,
  modelRuns: RUNS,
  deletes: DELETES,
  commits,
  commitsPerOp: Object.fromEntries(Object.entries(perOp).map(([k, v]) => [k, M.summary(v)])),
  replicaBytesPerCommit: Math.round(last.replica.bytes / commits),
  samples,
  afterIdle: after,
  at: new Date().toISOString(),
};
M.appendResult("growth-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));
