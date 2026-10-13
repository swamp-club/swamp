// Does a per-command sidecar re-snapshot after the writer's close resets the WAL?
// swamp-club#3357: the synthetic writer (node:sqlite, or swamp's own
// openCommitsDatabase with "swamp") closing between per-command sidecars. It
// does NOT re-snapshot; the real CLI does (probe_percommand_snapshot.ts).
// Usage: probe_wal_salt.ts <close|open|pre|lsfirst> [swamp]
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
import { openCommitsDatabase } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
const open = (p: string) => {
  if (Deno.args[1] !== "swamp") return L.openWriter(p, { appAutoCheckpoint: 1000 });
  const db = openCommitsDatabase(p);
  db.exec("CREATE TABLE IF NOT EXISTS commits2 (seq INTEGER PRIMARY KEY, id TEXT, payload BLOB, created_at INTEGER)");
  return db;
};
const ins = (db: ReturnType<typeof open>) => { const pl = new Uint8Array(2048); crypto.getRandomValues(pl); db.prepare("INSERT INTO commits2 (id,payload,created_at) VALUES (?,?,?)").run(crypto.randomUUID(), pl, Date.now()); };
const mode = Deno.args[0]; // "close" = writer closes between commands; "open" = writer stays open
const d = L.tmpdir("walreset");
const dbPath = join(d, "commits.db");
const sock = L.sockPath(d);
const cfg = L.writeConfig(d, dbPath, { kind: "file", path: join(d, "replica") }, { socket: sock });
Deno.writeTextFileSync(cfg, Deno.readTextFileSync(cfg).replace("level: warn", "level: debug"));
let db = open(dbPath);
for (let i = 0; i < 2000; i++) (Deno.args[1] === "swamp" ? ins(db) : L.insertCommit(db, 2048));
const sizes: number[] = [];
for (let i = 0; i < 6; i++) {
  if ((mode === "close" || mode === "pre") && i > 0) db = open(dbPath);
  let lsFirst: Deno.ChildProcess | undefined;
  if (mode === "lsfirst" && i > 0) {
    lsFirst = new Deno.Command(L.LITESTREAM, { args: ["replicate", "-config", cfg], stdout: "null", stderr: "piped" }).spawn();
    await L.waitReady(sock);
    db = open(dbPath);
  }
  if (mode === "pre" && i > 0) (Deno.args[1] === "swamp" ? ins(db) : L.insertCommit(db, 2048)); // a write before the sidecar starts
  const p = lsFirst ?? new Deno.Command(L.LITESTREAM, { args: ["replicate", "-config", cfg], stdout: "null", stderr: "piped" }).spawn();
  if (!lsFirst) await L.waitReady(sock);
  (Deno.args[1] === "swamp" ? ins(db) : L.insertCommit(db, 2048));
  await L.syncWait(sock, dbPath);
  if (mode === "close" || mode === "pre" || mode === "lsfirst") db.close();
  p.kill("SIGTERM");
  const out = await p.output();
  const log = new TextDecoder().decode(out.stderr);
  const l0 = [...Deno.readDirSync(join(d, "replica", "ltx", "0"))].map((e) => ({ n: e.name, s: Deno.statSync(join(d, "replica", "ltx", "0", e.name)).size })).sort((a, b) => a.n < b.n ? -1 : 1);
  sizes.push(l0[l0.length - 1].s);
  if (i === 2) console.log(log.split("\n").filter((x) => /snapshot|salt|reset|mismatch|init|checkpoint|position/i.test(x)).slice(0, 12).join("\n"));
}
console.log(mode, "db bytes", Deno.statSync(dbPath).size, "newest L0 per command", sizes);
