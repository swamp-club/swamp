// swamp-club#3357 Q5: the idle-sidecar design.
// Usage: exp_idle.ts gaps <profile> <gapsS,...> <samples>
//        exp_idle.ts faults <profile>
// Env: SWAMP_BIN (spike binary), LITESTREAM_BIN.
//
// gaps:   a long-lived sidecar; after each idle gap, one commit and a forced
//         sync. Shows when the sidecar's pooled connection stops being reused
//         (a new connection pays the handshake again).
// faults: the spike binary in idle mode, one scenario at a time:
//   reuse        second command finds the sidecar through pidfile + socket
//   killed       sidecar SIGKILLed between commands (socket file left behind)
//   stale-pid    pidfile names an unrelated live pid, no sidecar
//   frozen       sidecar SIGSTOPped: socket accepts, nothing answers
//   race         two writers start at once (the v3 writer lock serialises them)
//   sleep-wake   sidecar, watcher and proxy SIGSTOPped, pidfile aged past the
//                idle timeout, all SIGCONTed, then a command at once
import { join } from "jsr:@std/path@1";
import * as L from "./lib.ts";
import * as M from "./model.ts";

const [what, profileName, a3, a4] = Deno.args;
const profile = M.PROFILES[profileName];
if (!profile) throw new Error(`unknown profile ${profileName}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gaps(gapsS: number[], samples: number) {
  // IDLE_DROP_MS: the modelled server closes keep-alive connections idle
  // for longer than this (bucket_proxy.ts).
  const idleDropMs = Number(Deno.env.get("IDLE_DROP_MS") ?? 0);
  const proxy = await M.startProxy(profile, idleDropMs);
  const env = M.cleanEnv(profile.backend, proxy.port);
  const d = L.tmpdir("3357-gaps");
  const dbPath = join(d, "commits.db");
  const sock = L.sockPath(d);
  const cfg = L.writeConfig(
    d,
    dbPath,
    M.replicaSpec(profile.backend, proxy.port, `swamp-3357-gaps-${crypto.randomUUID()}`),
    // A long sync-interval so the background loop does not keep the
    // connection warm between forced syncs: only the forced sync uses it.
    { socket: sock, syncInterval: "1h" },
  );
  const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
  const p = L.startReplicate(cfg, env);
  await L.waitReady(sock);
  L.insertCommit(db, 2048);
  await L.syncWait(sock, dbPath);
  const rows: Record<string, unknown>[] = [];
  for (const gap of gapsS) {
    const ms: number[] = [], conns: number[] = [];
    for (let i = 0; i < samples; i++) {
      // Re-warm, then idle for the gap.
      L.insertCommit(db, 2048);
      await L.syncWait(sock, dbPath);
      await sleep(gap * 1000);
      await proxy.reset();
      L.insertCommit(db, 2048);
      const t = performance.now();
      const s = await L.syncWait(sock, dbPath);
      if (s.json.status !== "synced") throw new Error(JSON.stringify(s));
      ms.push(performance.now() - t);
      conns.push((await proxy.stats()).connections);
    }
    rows.push({ gapS: gap, syncMs: M.summary(ms), newConnections: conns });
    console.error(JSON.stringify(rows[rows.length - 1]));
  }
  await L.stop(p, "SIGTERM");
  db.close();
  await proxy.stop();
  return rows;
}

// --- faults -----------------------------------------------------------------
const SWAMP = Deno.env.get("SWAMP_BIN")!;
const LITESTREAM = Deno.env.get("LITESTREAM_BIN")!;

async function pids(pattern: string): Promise<number[]> {
  const r = await new Deno.Command("pgrep", { args: ["-f", pattern] }).output();
  return new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean).map(Number);
}

async function faults() {
  const proxyChild = await M.startProxy(profile);
  const root = Deno.makeTempDirSync({ prefix: "ls3357-idle-" });
  const realHome = Deno.env.get("HOME")!;
  const results: Record<string, unknown> = {};

  async function scenarioRepo(name: string) {
    const dir = join(root, name, "repo");
    const ds = join(root, name, "ds");
    Deno.mkdirSync(dir, { recursive: true });
    const env: Record<string, string> = {
      ...M.cleanEnv(profile.backend, proxyChild.port),
      HOME: realHome,
      SWAMP_NO_TELEMETRY: "1",
      SWAMP_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
    };
    const run = async (args: string[], extra: Record<string, string> = {}, timeoutMs = 60_000) => {
      const t0 = performance.now();
      const c = new Deno.Command(SWAMP, {
        args,
        cwd: dir,
        env: { ...env, ...extra },
        clearEnv: true,
        stdout: "null",
        stderr: "piped",
      }).spawn();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          c.kill("SIGKILL");
        } catch { /* gone */ }
      }, timeoutMs);
      const out = await c.output();
      clearTimeout(timer);
      return {
        ms: Math.round(performance.now() - t0),
        ok: out.success,
        timedOut,
        err: new TextDecoder().decode(out.stderr).slice(-400),
      };
    };
    await run(["repo", "init", "--tool", "none"]);
    await run(["datastore", "setup", "filesystem", "--path", ds, "--format", "3"]);
    const mdir = join(dir, "models", "command", "shell");
    Deno.mkdirSync(mdir, { recursive: true });
    Deno.writeTextFileSync(
      join(mdir, "small.yaml"),
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
    const replicaPath = `swamp-3357-idle-${crypto.randomUUID().slice(0, 8)}/${name}`;
    const spike = {
      SWAMP_SPIKE_LITESTREAM: "idle",
      SWAMP_SPIKE_LITESTREAM_BIN: LITESTREAM,
      SWAMP_SPIKE_LITESTREAM_IDLE_S: "20",
      SWAMP_SPIKE_LITESTREAM_REPLICA: JSON.stringify(
        profile.backend === "s3"
          ? { type: "s3", bucket: M.BUCKET, path: replicaPath, endpoint: `http://localhost:${proxyChild.port}` }
          : { type: "gs", bucket: M.BUCKET, path: replicaPath },
      ),
      SWAMP_SPIKE_LITESTREAM_LOG: join(root, name, "spike.jsonl"),
    };
    const cmd = (timeoutMs?: number) =>
      run(["model", "method", "run", "small", "execute"], spike, timeoutMs);
    const sidecars = () => pids(`litestream replicate -config .*spike-litestream`);
    const pidfileDir = join(realHome, ".swamp", "spike-litestream");
    const log = () => {
      try {
        return Deno.readTextFileSync(join(root, name, "spike.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    return { cmd, sidecars, pidfileDir, log, ds };
  }

  async function killAll(before: number[]) {
    for (const pid of before) {
      try {
        Deno.kill(pid, "SIGCONT");
        Deno.kill(pid, "SIGKILL");
      } catch { /* gone */ }
    }
  }
  /** The sidecar this scenario started: new litestream pids since `before`. */
  async function newSidecars(r: { sidecars: () => Promise<number[]> }, before: number[]) {
    return (await r.sidecars()).filter((p) => !before.includes(p));
  }

  const baseline = await pids(`litestream replicate -config .*spike-litestream`);

  // reuse
  {
    const r = await scenarioRepo("reuse");
    const first = await r.cmd();
    const second = await r.cmd();
    const third = await r.cmd();
    results.reuse = { first, second, third, sidecars: (await newSidecars(r, baseline)).length, log: r.log() };
    await killAll(await newSidecars(r, baseline));
  }
  // killed
  {
    const r = await scenarioRepo("killed");
    await r.cmd();
    const sc = await newSidecars(r, baseline);
    for (const p of sc) Deno.kill(p, "SIGKILL");
    await sleep(200);
    const next = await r.cmd();
    results.killed = { next, sidecarsAfter: (await newSidecars(r, baseline)).length, log: r.log() };
    await killAll(await newSidecars(r, baseline));
  }
  // stale-pid: a pidfile naming this harness's own pid, and no socket.
  {
    const r = await scenarioRepo("stale-pid");
    await r.cmd();
    const sc = await newSidecars(r, baseline);
    await killAll(sc);
    for (const e of Deno.readDirSync(r.pidfileDir)) {
      if (e.name.endsWith(".pid")) Deno.writeTextFileSync(join(r.pidfileDir, e.name), String(Deno.pid));
    }
    const next = await r.cmd();
    results["stale-pid"] = { next, sidecarsAfter: (await newSidecars(r, baseline)).length, log: r.log() };
    await killAll(await newSidecars(r, baseline));
  }
  // frozen: the socket accepts but nothing answers.
  {
    const r = await scenarioRepo("frozen");
    await r.cmd();
    const sc = await newSidecars(r, baseline);
    for (const p of sc) Deno.kill(p, "SIGSTOP");
    const next = await r.cmd(20_000);
    results.frozen = { next, sidecarsAfter: (await newSidecars(r, baseline)).length };
    await killAll(await newSidecars(r, baseline));
  }
  // race: two writers at once.
  {
    const r = await scenarioRepo("race");
    const [x, y] = await Promise.all([r.cmd(), r.cmd()]);
    results.race = { x, y, sidecars: (await newSidecars(r, baseline)).length, log: r.log() };
    await killAll(await newSidecars(r, baseline));
  }
  // sleep-wake
  {
    const r = await scenarioRepo("sleep-wake");
    await r.cmd();
    const sc = await newSidecars(r, baseline);
    const watchers: number[] = [];
    for (const p of sc) {
      const out = await new Deno.Command("pgrep", { args: ["-P", String(p)] }).output();
      watchers.push(...new TextDecoder().decode(out.stdout).trim().split("\n").filter(Boolean).map(Number));
    }
    const proxyPids = await pids(`bucket_proxy.ts ${proxyChild.port}`);
    const frozen = [...sc, ...watchers, ...proxyPids];
    for (const p of frozen) Deno.kill(p, "SIGSTOP");
    await sleep(5000);
    const old = new Date(Date.now() - 3600_000);
    for (const e of Deno.readDirSync(r.pidfileDir)) {
      if (e.name.endsWith(".pid")) Deno.utimeSync(join(r.pidfileDir, e.name), old, old);
    }
    for (const p of frozen) Deno.kill(p, "SIGCONT");
    const next = await r.cmd(60_000);
    await sleep(3000);
    const after = await r.cmd(60_000);
    results["sleep-wake"] = {
      watchers: watchers.length,
      next,
      after,
      sidecarsAfter: (await newSidecars(r, baseline)).length,
      log: r.log(),
    };
    await killAll(await newSidecars(r, baseline));
  }
  await proxyChild.stop();
  return results;
}

let row: Record<string, unknown>;
if (what === "gaps") {
  row = {
    exp: "idle-gaps",
    profile,
    idleDropMs: Number(Deno.env.get("IDLE_DROP_MS") ?? 0),
    at: new Date().toISOString(),
    rows: await gaps(a3.split(",").map(Number), Number(a4 ?? 3)),
  };
} else {
  row = { exp: "idle-faults", profile, at: new Date().toISOString(), results: await faults() };
}
M.appendResult("idle-darwin-arm64.jsonl", row);
console.log(JSON.stringify(row));
