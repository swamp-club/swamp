// Spawns litestream like a CLI would, prints its pid, then idles until killed.
import * as L from "./lib.ts";
const p = L.startReplicate(Deno.args[0]);
await L.waitReady(Deno.args[1]);
console.log(p.pid);
await new Promise(() => {});
