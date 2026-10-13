// swamp-club#3357: which step of a CLI write command rewinds the WAL, so a
// per-command sidecar re-snapshots? Runs the spike binary in percommand mode
// against a file replica (no emulator needed) with the WAL trace on.
// Usage: exp_wal_trace.ts <variant> [commands]
//   variant: default | no-compact | no-autockpt | no-compact-no-autockpt |
//            readonly-between (a read-only `data list` between writes) |
//            sync-close-stop (sync, close the stores, then stop the sidecar)
// Env: SWAMP_BIN, LITESTREAM_BIN.
import { join } from "jsr:@std/path@1";
import * as M from "./model.ts";

const [variant, nStr] = Deno.args;
const N = Number(nStr ?? 6);
const SWAMP = Deno.env.get("SWAMP_BIN")!;
const LITESTREAM = Deno.env.get("LITESTREAM_BIN")!;
const root = Deno.makeTempDirSync({ prefix: "ls3357-waltrace-" });
const repo = join(root, "repo"), ds = join(root, "ds"), replica = join(root, "replica");
const walLog = join(root, "wal.jsonl");
Deno.mkdirSync(join(repo, "models", "command", "shell"), { recursive: true });

const base: Record<string, string> = {
  PATH: Deno.env.get("PATH")!,
  HOME: Deno.env.get("HOME")!,
  TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
  SWAMP_NO_TELEMETRY: "1",
  SWAMP_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
};
const spike = (i: number): Record<string, string> => ({
  SWAMP_SPIKE_LITESTREAM: "percommand",
  SWAMP_SPIKE_LITESTREAM_BIN: LITESTREAM,
  SWAMP_SPIKE_LITESTREAM_REPLICA: JSON.stringify({ type: "file", path: replica }),
  SWAMP_SPIKE_LITESTREAM_LOGLEVEL: "debug",
  SWAMP_SPIKE_LITESTREAM_STDOUT: join(root, `ls-${i}.log`),
  SWAMP_SPIKE_WAL_LOG: walLog,
  ...(variant.includes("no-compact") ? { SWAMP_SPIKE_NO_COMPACT: "1" } : {}),
  ...(variant.includes("no-autockpt") ? { SWAMP_SPIKE_NO_AUTOCKPT: "1" } : {}),
  ...(variant.includes("sync-close-stop") ? { SWAMP_SPIKE_LITESTREAM_ORDER: "sync-close-stop" } : {}),
});
async function swamp(args: string[], env: Record<string, string> = {}) {
  const r = await new Deno.Command(SWAMP, {
    args,
    cwd: repo,
    env: { ...base, ...env },
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr).slice(-1500));
}
await swamp(["repo", "init", "--tool", "none"]);
await swamp(["datastore", "setup", "filesystem", "--path", ds, "--format", "3"]);
Deno.writeTextFileSync(
  join(repo, "models", "command", "shell", "small.yaml"),
  [
    "type: command/shell",
    "typeVersion: 2026.02.09.1",
    `id: ${crypto.randomUUID()}`,
    "name: small",
    "version: 1",
    "tags: {}",
    "globalArguments: {}",
    "methods:",
    "  execute:",
    "    arguments:",
    `      run: "head -c 768 /dev/urandom | base64"`,
    "",
  ].join("\n"),
);

const l0 = () => {
  try {
    return [...Deno.readDirSync(join(replica, "ltx", "0"))].map((e) => e.name).sort();
  } catch {
    return [];
  }
};
const rows: Record<string, unknown>[] = [];
for (let i = 0; i < N; i++) {
  Deno.writeTextFileSync(walLog, JSON.stringify({ label: `-- command ${i}` }) + "\n", { append: true });
  if (variant === "readonly-between" && i > 0) {
    await swamp(["data", "list", "small", "--json"], { SWAMP_SPIKE_WAL_LOG: walLog });
  }
  const before = new Set(l0());
  await swamp(["model", "method", "run", "small", "execute"], spike(i));
  const added = l0().filter((n) => !before.has(n));
  const log = (() => {
    try {
      return Deno.readTextFileSync(join(root, `ls-${i}.log`));
    } catch {
      return "";
    }
  })();
  const reasons = [...log.matchAll(/snap=true reason="([^"]*)"/g)].map((m) => m[1]);
  const verify = [...log.matchAll(/msg=verify[^\n]*?saltMatch=(\w+) prevWALOffset=(\d+)/g)].map((m) => `${m[1]}@${m[2]}`);
  rows.push({
    command: i,
    l0Added: added.map((n) => `${n}:${Deno.statSync(join(replica, "ltx", "0", n)).size}`),
    snapshotReasons: reasons,
    verify,
  });
}
const trace = Deno.readTextFileSync(walLog).trim().split("\n").map((l) => JSON.parse(l));
const row = { exp: "wal-trace", variant, commands: N, at: new Date().toISOString(), rows, trace };
M.appendResult("wal-trace-darwin-arm64.jsonl", row);
console.log(JSON.stringify({ variant, rows }));
console.error(`trace: ${walLog}`);
