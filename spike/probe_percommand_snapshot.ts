// swamp-club#3357: reproduces the per-command re-snapshot. A Litestream sidecar
// (debug log) is started and stopped around each real swamp command, with the
// prototype off. Look for: reason="wal header salt reset, snapshotting".
// Usage: probe_percommand_snapshot.ts <repoDir> <v3DatastorePath> <outDir> [hold]
// Env: SWAMP_BIN, LITESTREAM_BIN.
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const [repo, ds, out, hold] = Deno.args;
// "hold": keep one extra connection open on commits.db across every command,
// so no process is ever the last connection and SQLite never checkpoints on
// close (the checkpoint-on-close hypothesis for the re-snapshot).
import { DatabaseSync } from "node:sqlite";
const keeper = hold === "hold" ? new DatabaseSync(join(ds, "commits.db")) : undefined;
const dbPath = join(ds, "commits.db");
const sock = `/tmp/ls3357-man.sock`;
const cfg = L.writeConfig(out, dbPath, { kind: "file", path: join(out, "replica") }, { socket: sock });
Deno.writeTextFileSync(cfg, Deno.readTextFileSync(cfg).replace("level: warn", "level: debug"));
const env = { ...Deno.env.toObject() };
for (const k of Object.keys(env)) if (k.startsWith("SWAMP_SPIKE")) delete env[k];
for (let i = 0; i < 5; i++) {
  const p = new Deno.Command(L.LITESTREAM, { args: ["replicate", "-config", cfg], stdout: "piped", stderr: "piped" }).spawn();
  await L.waitReady(sock);
  const r = await new Deno.Command(Deno.env.get("SWAMP_BIN")!, { args: ["model", "method", "run", "small", "execute"], cwd: repo, env, clearEnv: true, stdout: "null", stderr: "null" }).output();
  await L.syncWait(sock, dbPath);
  p.kill("SIGTERM");
  const o = await p.output();
  const log = new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr);
  Deno.writeTextFileSync(join(out, `ls-${i}.log`), log);
  const dir = join(out, "replica", "ltx", "0");
  const l0 = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
  const snap = /snapshotting/.test(log);
  console.log(i, r.success, "snapshot:", snap, l0.slice(-2).map((n) => n + ":" + Deno.statSync(join(dir, n)).size).join(" "));
}
keeper?.close();
