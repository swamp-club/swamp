// swamp-club#3357: the replica path under the fenced writer lease. Compares a
// path per fence with a path per lineage, and checks the lineage rules:
// consecutive commands continue one path, another writer's fence starts a new
// one, and a crashed command's successor continues its own.
// Usage: exp_lineage.ts
// Env: SWAMP_BIN (spike binary on main with the lease), LITESTREAM_BIN.
// File replica, so bytes are file sizes; the sidecar order is
// sync-close-stop (the fix for the per-command re-snapshot).
import { join } from "jsr:@std/path@1";
import { DatabaseSync } from "node:sqlite";
import * as L from "./lib.ts";
import * as M from "./model.ts";

const SWAMP = Deno.env.get("SWAMP_BIN")!;
const LITESTREAM = Deno.env.get("LITESTREAM_BIN")!;

function walk(d: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  try {
    for (const e of Deno.readDirSync(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) {
        const s = walk(p);
        files += s.files;
        bytes += s.bytes;
      } else {
        files++;
        bytes += Deno.statSync(p).size;
      }
    }
  } catch { /* none */ }
  return { files, bytes };
}

async function scenario(name: string, mode: "percommand" | "idle", pathMode: string) {
  const root = Deno.makeTempDirSync({ prefix: `ls3357-lineage-${name}-` });
  const repo = join(root, "repo"), ds = join(root, "ds"), replica = join(root, "replica");
  const pathLog = join(root, "paths.jsonl");
  Deno.mkdirSync(join(repo, "models", "command", "shell"), { recursive: true });
  const base: Record<string, string> = {
    PATH: Deno.env.get("PATH")!,
    HOME: Deno.env.get("HOME")!,
    TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
    SWAMP_NO_TELEMETRY: "1",
    SWAMP_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
  const spike: Record<string, string> = {
    SWAMP_SPIKE_LITESTREAM: mode,
    SWAMP_SPIKE_LITESTREAM_BIN: LITESTREAM,
    SWAMP_SPIKE_LITESTREAM_REPLICA: JSON.stringify({ type: "file", path: replica }),
    SWAMP_SPIKE_LITESTREAM_ORDER: "sync-close-stop",
    SWAMP_SPIKE_LITESTREAM_PATHMODE: pathMode,
    SWAMP_SPIKE_LITESTREAM_PATHLOG: pathLog,
    SWAMP_SPIKE_LITESTREAM_IDLE_S: "60",
  };
  const run = (args: string[], withSpike: boolean) =>
    new Deno.Command(SWAMP, {
      args,
      cwd: repo,
      env: withSpike ? { ...base, ...spike } : base,
      clearEnv: true,
      stdout: "null",
      stderr: "piped",
    });
  const swamp = async (args: string[], withSpike = true) => {
    const r = await run(args, withSpike).output();
    if (!r.success) throw new Error(new TextDecoder().decode(r.stderr).slice(-1500));
  };
  await swamp(["repo", "init", "--tool", "none"], false);
  await swamp(["datastore", "setup", "filesystem", "--path", ds, "--format", "3"], false);
  const model = (n: string, cmd: string) =>
    Deno.writeTextFileSync(
      join(repo, "models", "command", "shell", `${n}.yaml`),
      [
        "type: command/shell",
        "typeVersion: 2026.02.09.1",
        `id: ${crypto.randomUUID()}`,
        `name: ${n}`,
        "version: 1",
        "tags: {}",
        "globalArguments: {}",
        "methods:",
        "  execute:",
        "    arguments:",
        `      run: "${cmd}"`,
        "",
      ].join("\n"),
    );
  model("small", "head -c 768 /dev/urandom | base64");
  model("slow", "sleep 4; head -c 768 /dev/urandom | base64");
  const write = () => swamp(["model", "method", "run", "small", "execute"]);
  const steps: Record<string, unknown>[] = [];
  const snap = (label: string) => {
    steps.push({ label, replica: walk(replica), db: Deno.statSync(join(ds, "commits.db")).size });
  };

  // Six consecutive commands from this copy.
  for (let i = 0; i < 6; i++) await write();
  snap("after 6 consecutive commands");
  // Another writer takes the lease twice (replication off for it).
  await swamp(["model", "method", "run", "small", "execute"], false);
  await swamp(["model", "method", "run", "small", "execute"], false);
  await write();
  snap("after another writer's 2 fences, then 1 command");
  await write();
  snap("after 1 more command");
  // A command killed mid-run, after it took the lease.
  const killed = run(["model", "method", "run", "slow", "execute"], true).spawn();
  await new Promise((r) => setTimeout(r, 1500));
  killed.kill("SIGKILL");
  await killed.status;
  await new Promise((r) => setTimeout(r, 200));
  // Its lease has to expire before the next writer can take the next fence:
  // force-release it, as an operator would, rather than wait out the TTL.
  await swamp(["datastore", "lock", "release", "--force"], false).catch(() => {});
  await write();
  snap("after a killed command and 1 command");

  // Stop any idle sidecar, then check every replica path against the
  // local database.
  if (mode === "idle") {
    const dir = join(base.HOME, ".swamp", "spike-litestream");
    for (const e of Deno.readDirSync(dir)) {
      if (!e.name.endsWith(".pid")) continue;
      try {
        const pid = Number(Deno.readTextFileSync(join(dir, e.name)).trim());
        if (pid > 0) Deno.kill(pid, "SIGTERM");
      } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const count = (p: string) => {
    const db = new DatabaseSync(p, { readOnly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM commits").get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  const localCommits = count(join(ds, "commits.db"));
  const paths: Record<string, unknown>[] = [];
  const dirs = pathMode === "fixed" ? [replica] : [...Deno.readDirSync(replica)].map((e) => join(replica, e.name)).sort();
  for (const p of dirs) {
    const d = Deno.makeTempDirSync({ prefix: "ls3357-lineage-restore-" });
    const cfg = L.writeConfig(d, join(d, "src.db"), { kind: "file", path: p }, { socket: L.sockPath(d) });
    const out = join(d, "out.db");
    try {
      await L.restore(cfg, join(d, "src.db"), out, {});
      paths.push({ path: p.slice(replica.length) || "/", ...walk(p), integrity: L.verifyIntegrity(out), commits: count(out) });
    } catch (e) {
      paths.push({ path: p.slice(replica.length) || "/", error: String(e).slice(0, 200) });
    }
  }
  const decisions = Deno.readTextFileSync(pathLog).trim().split("\n").map((l) => JSON.parse(l));
  return { name, mode, pathMode, localCommits, steps, decisions, paths };
}

const results = [];
for (const [name, mode, pm] of [
  ["percommand-fence", "percommand", "fence"],
  ["percommand-lineage", "percommand", "lineage"],
  ["idle-lineage", "idle", "lineage"],
] as const) {
  const r = await scenario(name, mode, pm);
  console.error(JSON.stringify(r));
  results.push(r);
}
const row = { exp: "lineage", at: new Date().toISOString(), results };
M.appendResult("lineage-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));
