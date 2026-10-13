// swamp-club#3357 Q5 follow-up: after an idle sidecar has timed out, does
// the next command's fresh sidecar re-snapshot commits.db?
// Usage: exp_idle_restart.ts <warmCommands> <cycles>
// Env: SWAMP_BIN, LITESTREAM_BIN. Runs on ministack, uncapped (bytes only).
//
// Grows commits.db with <warmCommands> commands on one live sidecar, then
// for each cycle: waits past the idle timeout (sidecar exits), runs one
// command (fresh sidecar), and records the bytes that command uploaded and
// whether Litestream logged a snapshot.
import { join } from "jsr:@std/path@1";
import * as M from "./model.ts";

const [warmStr, cyclesStr] = Deno.args;
const WARM = Number(warmStr ?? 100), CYCLES = Number(cyclesStr ?? 3);
const IDLE_S = 5;
const SWAMP = Deno.env.get("SWAMP_BIN")!;
const LITESTREAM = Deno.env.get("LITESTREAM_BIN")!;
const proxy = await M.startProxy(M.PROFILES["s3-zero"]);
const root = Deno.makeTempDirSync({ prefix: "ls3357-idlerestart-" });
const repo = join(root, "repo"), ds = join(root, "ds");
Deno.mkdirSync(join(repo, "models", "command", "shell"), { recursive: true });
const env: Record<string, string> = {
  ...M.cleanEnv("s3", proxy.port),
  SWAMP_NO_TELEMETRY: "1",
  SWAMP_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
};
const spike = {
  SWAMP_SPIKE_LITESTREAM: "idle",
  SWAMP_SPIKE_LITESTREAM_BIN: LITESTREAM,
  SWAMP_SPIKE_LITESTREAM_IDLE_S: String(IDLE_S),
  SWAMP_SPIKE_LITESTREAM_LOG: join(root, "spike.jsonl"),
  SWAMP_SPIKE_LITESTREAM_REPLICA: JSON.stringify({
    type: "s3",
    bucket: M.BUCKET,
    path: `swamp-3357-idlerestart-${crypto.randomUUID().slice(0, 8)}`,
    endpoint: `http://localhost:${proxy.port}`,
  }),
};
async function swamp(args: string[], withSpike = true) {
  const r = await new Deno.Command(SWAMP, {
    args,
    cwd: repo,
    env: withSpike ? { ...env, ...spike } : env,
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr).slice(-1500));
}
await swamp(["repo", "init", "--tool", "none"], false);
await swamp(["datastore", "setup", "filesystem", "--path", ds, "--format", "3"], false);
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
const cmd = ["model", "method", "run", "small", "execute"];
for (let i = 0; i < WARM; i++) await swamp(cmd);
await proxy.reset();
await swamp(cmd);
const warmBytes = (await proxy.stats()).bytesUp;
const cycles: Record<string, unknown>[] = [];
for (let c = 0; c < CYCLES; c++) {
  await new Promise((r) => setTimeout(r, (IDLE_S + 4) * 1000));
  await proxy.reset();
  await swamp(cmd);
  const st = await proxy.stats();
  // A second command right after, on the now-warm sidecar.
  await proxy.reset();
  await swamp(cmd);
  const st2 = await proxy.stats();
  cycles.push({ restartBytesUp: st.bytesUp, restartRequests: st.requests, nextBytesUp: st2.bytesUp });
}
const dbBytes = Deno.statSync(join(ds, "commits.db")).size;
const row = {
  exp: "idle-restart",
  warmCommands: WARM,
  idleTimeoutS: IDLE_S,
  dbBytes,
  warmCommandBytesUp: warmBytes,
  cycles,
  at: new Date().toISOString(),
};
M.appendResult("idle-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));
await proxy.stop();
