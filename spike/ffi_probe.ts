// Option b: Litestream Go library as a c-shared lib inside the Deno process.
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const t0 = performance.now();
const lib = Deno.dlopen(new URL("./golib/liblitestream.dylib", import.meta.url), {
  LsOpen: { parameters: ["buffer", "buffer"], result: "i32" },
  LsSync: { parameters: [], result: "pointer" },
  LsFree: { parameters: ["pointer"], result: "void" },
  LsClose: { parameters: [], result: "i32" },
});
const tLoad = performance.now() - t0;
const cstr = (s: string) => new TextEncoder().encode(s + "\0");
const d = L.tmpdir("ffi");
const dbPath = join(d, "commits.db");
const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
const t1 = performance.now();
console.log("open", lib.symbols.LsOpen(cstr(dbPath), cstr(join(d, "replica"))), "ms", (performance.now() - t1).toFixed(1), "dlopen ms", tLoad.toFixed(1));
const syncs: number[] = [];
for (let i = 0; i < 20; i++) {
  L.insertCommit(db, 2048);
  const t = performance.now();
  const p = lib.symbols.LsSync()!;
  const j = new Deno.UnsafePointerView(p).getCString();
  lib.symbols.LsFree(p);
  syncs.push(performance.now() - t);
  if (i === 19) console.log("last sync", j);
}
console.log("sync", L.stats(syncs));
// Does a Deno signal listener still work with the Go runtime loaded?
let got = false;
Deno.addSignalListener("SIGUSR1", () => { got = true; });
Deno.kill(Deno.pid, "SIGUSR1");
await new Promise((r) => setTimeout(r, 200));
console.log("deno SIGUSR1 listener fired with Go runtime loaded:", got);
console.log("close", lib.symbols.LsClose());
db.close();
await L.restore(null, "file://" + join(d, "replica"), join(d, "r.db"));
console.log(L.verifyRestored(join(d, "r.db")));
Deno.exit(0);
