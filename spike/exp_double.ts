// Per-command risk: an orphaned sidecar is still running when the next command
// starts another litestream on the SAME local db and replica path.
// Usage: exp_double.ts [iterations]
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const ITER = Number(Deno.args[0] ?? 5);
const res: unknown[] = [];
for (let it = 0; it < ITER; it++) {
  const d = L.tmpdir("double");
  const dbPath = join(d, "commits.db");
  const s1 = L.sockPath(d), s2 = L.sockPath(d);
  const replica: L.ReplicaSpec = { kind: "file", path: join(d, "replica") };
  const c1 = L.writeConfig(d, dbPath, replica, { socket: s1 });
  Deno.renameSync(c1, join(d, "c1.yml"));
  const c2 = L.writeConfig(d, dbPath, replica, { socket: s2 });
  const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
  const p1 = L.startReplicate(join(d, "c1.yml"));
  await L.waitReady(s1);
  const p2 = L.startReplicate(c2);
  await L.waitReady(s2);
  const st: string[] = [];
  for (let k = 0; k < 30; k++) {
    for (let i = 0; i < 50; i++) L.insertCommit(db, 2000);
    const a = await L.syncWait(k % 2 ? s1 : s2, dbPath).catch((e) => ({ json: { status: String(e) } }));
    st.push(String(a.json.status));
  }
  const last = (db.prepare("SELECT max(seq) m FROM commits").get() as { m: number }).m;
  await L.stop(p1, "SIGTERM"); await L.stop(p2, "SIGTERM"); db.close();
  const out = join(d, "r.db");
  try { await L.restore(c2, dbPath, out); const v = L.verifyRestored(out); res.push({ ok: v.integrity === "ok" && v.maxSeq === last, v, last, statuses: [...new Set(st)] }); }
  catch (e) { res.push({ ok: false, restoreError: (e as Error).message.slice(0, 200), statuses: [...new Set(st)] }); }
}
console.log(JSON.stringify({ ok: res.filter((r) => (r as { ok: boolean }).ok).length, of: ITER, res }));
