// Q7: platform behaviour of the sidecar model. Prints one JSON line.
// - control socket reachable from Deno (AF_UNIX; Windows 10 1803+)
// - stop semantics: what kill("SIGTERM") does to the sidecar, and whether its
//   final sync runs (Windows has no SIGTERM; Go only sees os.Interrupt there)
// - file locking: can the db be renamed/removed while litestream holds it
// - paths with spaces
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const out: Record<string, unknown> = { os: Deno.build.os, arch: Deno.build.arch, deno: Deno.version.deno };
const d = join(L.tmpdir("probe"), "dir with spaces");
Deno.mkdirSync(d);
const dbPath = join(d, "commits.db");
const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
const sock = L.sockPath(d);
const cfg = L.writeConfig(d, dbPath, { kind: "file", path: join(d, "replica dir") }, { socket: sock });
let p = L.startReplicate(cfg);
try {
  out.readyMs = Math.round(await L.waitReady(sock));
  out.controlSocket = "ok";
} catch (e) {
  out.controlSocket = `failed: ${(e as Error).message}`;
}
for (let i = 0; i < 50; i++) L.insertCommit(db, 1024);
if (out.controlSocket === "ok") {
  const r = await L.syncWait(sock, dbPath);
  out.forcedSync = r.json.status;
}
// File locking while the replicator holds the db open.
const tryOp = (f: () => void) => { try { f(); return "ok"; } catch (e) { return `refused: ${(e as Error).name}`; } };
// `litestream sync -wait` as a subprocess client: the portable way to reach
// the control socket where the runtime has no AF_UNIX client.
if (out.controlSocket === "ok") {
  const t: number[] = [];
  let lastOut = "";
  for (let i = 0; i < 10; i++) {
    L.insertCommit(db, 1024);
    const t0 = performance.now();
    const r = await new Deno.Command(L.LITESTREAM, { args: ["sync", "-socket", sock, "-wait", "-json", dbPath] }).output();
    t.push(performance.now() - t0);
    lastOut = new TextDecoder().decode(r.success ? r.stdout : r.stderr).trim().slice(0, 200);
  }
  out.syncCommandMs = L.stats(t);
  out.syncCommandLast = lastOut;
}
// Stop semantics after the db is initialised (past the first monitor tick).
await new Promise((r) => setTimeout(r, 1500));
for (let i = 0; i < 5; i++) L.insertCommit(db, 1024);
const st = await L.stop(p, "SIGTERM");
out.sigtermStop = st;
const r1 = join(d, "r1.db");
try {
  await L.restore(cfg, dbPath, r1);
  out.finalSyncOnSigterm = L.verifyRestored(r1).maxSeq === 65;
} catch (e) {
  out.finalSyncOnSigterm = `restore failed: ${(e as Error).message.slice(0, 120)}`;
}
// After a hard stop, a restart must ship what the last process missed.
p = L.startReplicate(cfg);
if (out.controlSocket === "ok") {
  await L.waitReady(sock);
  out.restartCatchUp = (await L.syncWait(sock, dbPath)).json.status;
}
db.close();
// Windows refuses to delete files another process holds open; swamp's reset
// and restore-over paths would hit this while the sidecar runs.
Deno.copyFileSync(dbPath, dbPath + ".bak");
out.removeDbWhileSidecarHoldsIt = tryOp(() => Deno.removeSync(dbPath));
await L.stop(p, "SIGKILL");
out.removeDbAfterSidecarStops = tryOp(() => { try { Deno.statSync(dbPath); Deno.removeSync(dbPath); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; } });
const r2 = join(d, "r2.db");
await L.restore(cfg, dbPath, r2);
const v = L.verifyRestored(r2);
out.restoredAfterRestart = v;
out.allCommitsReplicated = v.maxSeq === 65 && v.integrity === "ok";
console.log(JSON.stringify(out));
