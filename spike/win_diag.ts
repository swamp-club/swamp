// Q7 Windows diagnostics: which half of the control socket fails, and does
// restore work at all on Windows. Prints one JSON line.
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const out: Record<string, unknown> = { os: Deno.build.os, arch: Deno.build.arch };
const d = L.tmpdir("wdiag");
const dbPath = join(d, "commits.db");
const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
const sock = join(d, "ls.sock");
const cfg = L.writeConfig(d, dbPath, { kind: "file", path: join(d, "replica") }, { socket: sock });
Deno.writeTextFileSync(cfg, Deno.readTextFileSync(cfg).replace("level: warn", "level: info"));
const p = new Deno.Command(L.LITESTREAM, { args: ["replicate", "-config", cfg], stdout: "piped", stderr: "piped" }).spawn();
await new Promise((r) => setTimeout(r, 2500));
try { out.socketStat = Deno.statSync(sock).isFile ? "file" : "exists"; } catch (e) { out.socketStat = `missing: ${(e as Error).name}`; }
try {
  const c = await Deno.connect({ transport: "unix", path: sock });
  c.close();
  out.denoUnixConnect = "ok";
} catch (e) {
  out.denoUnixConnect = `${(e as Error).name}: ${(e as Error).message}`;
}
const curl = await new Deno.Command("curl", { args: ["-s", "--unix-socket", sock, "http://litestream/info"] }).output().catch((e) => ({ success: false, stdout: new Uint8Array(), stderr: new TextEncoder().encode(String(e)) }));
out.curlUnixSocket = curl.success ? new TextDecoder().decode(curl.stdout).slice(0, 200) : `failed: ${new TextDecoder().decode(curl.stderr).slice(0, 200)}`;
for (let i = 0; i < 50; i++) L.insertCommit(db, 1024);
const curlSync = await new Deno.Command("curl", { args: ["-s", "--unix-socket", sock, "-X", "POST", "-d", JSON.stringify({ path: dbPath, wait: true }), "http://litestream/sync"] }).output().catch(() => null);
out.curlSync = curlSync?.success ? new TextDecoder().decode(curlSync.stdout).slice(0, 300) : "failed";
await new Promise((r) => setTimeout(r, 2500));
try { p.kill("SIGTERM"); } catch (e) { out.killSigterm = String(e); }
const st = await p.status;
out.exit = st;
const logs = new TextDecoder().decode((await p.output().catch(() => null))?.stderr ?? new Uint8Array());
out.litestreamLog = logs.split("\n").filter((l) => /WARN|ERROR|socket|replicating|shut/i.test(l)).map((l) => l.replace(/time=\S+ /, "")).slice(0, 12);
db.close();
// Restore into a plain dir, a dir with spaces, and the temp root.
for (const target of [join(d, "r1.db"), join(Deno.makeTempDirSync(), "r2.db")]) {
  const r = await new Deno.Command(L.LITESTREAM, { args: ["restore", "-config", cfg, "-o", target, dbPath] }).output();
  out[`restore:${target.slice(-6)}`] = r.success ? L.verifyRestored(target) : new TextDecoder().decode(r.stderr).trim().slice(-200);
}
const r3 = await new Deno.Command(L.LITESTREAM, { args: ["ltx", "-config", cfg, dbPath] }).output();
out.replicaListing = new TextDecoder().decode(r3.stdout).trim().split("\n").slice(0, 3);
console.log(JSON.stringify(out));
