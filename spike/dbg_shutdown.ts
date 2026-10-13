import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const d = L.tmpdir("dbg");
const dbPath = join(d, "commits.db");
const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
const sock = join(d, "ls.sock");
const cfg = L.writeConfig(d, dbPath, { kind: "file", path: join(d, "replica") }, { socket: sock });
Deno.writeTextFileSync(cfg, Deno.readTextFileSync(cfg).replace("level: warn", "level: debug"));
const wait = Number(Deno.args[0] ?? 0);
const p = L.startReplicate(cfg);
await L.waitReady(sock);
await new Promise((r) => setTimeout(r, wait));
let last = 0;
for (let k = 0; k < 5; k++) last = L.insertCommit(db, 2048);
console.log("---- SIGTERM");
console.log(await L.stop(p, "SIGTERM"));
const out = join(d, "r.db");
await L.restore(null, "file://" + join(d, "replica"), out).catch((e) => console.log("restore:", e.message.slice(0, 200)));
try { console.log("last", last, L.verifyRestored(out)); } catch (e) { console.log("verify", (e as Error).message); }
