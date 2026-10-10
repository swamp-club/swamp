// Q6 follow-up: a zombie old leader out-syncs the new leader on a SHARED
// replica path. What does a fresh restore return? Usage: exp_zombie.ts [iterations]
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const ITER = Number(Deno.args[0] ?? 5);
const results: Record<string, unknown>[] = [];
for (let it = 0; it < ITER; it++) {
  const root = L.tmpdir("zombie");
  const replica = join(root, "replica");
  const mk = (name: string) => {
    const d = join(root, name);
    Deno.mkdirSync(d);
    const dbPath = join(d, "commits.db");
    const sock = `/tmp/ls3234-${crypto.randomUUID().slice(0, 8)}.sock`;
    return { dbPath, sock, cfg: L.writeConfig(d, dbPath, { kind: "file", path: replica }, { socket: sock }) };
  };
  const a = mk("a");
  const dbA = L.openWriter(a.dbPath, { appAutoCheckpoint: 1000 });
  const pA = L.startReplicate(a.cfg);
  await L.waitReady(a.sock);
  for (let i = 0; i < 100; i++) L.insertCommit(dbA, 1000);
  await L.syncWait(a.sock, a.dbPath);
  const b = mk("b");
  await L.restore(a.cfg, a.dbPath, b.dbPath);
  const dbB = L.openWriter(b.dbPath, { appAutoCheckpoint: 1000 });
  dbB.exec("CREATE TABLE IF NOT EXISTS owner (who TEXT)");
  dbB.exec("INSERT INTO owner VALUES ('B')");
  const pB = L.startReplicate(b.cfg);
  await L.waitReady(b.sock);
  const sB = await L.syncWait(b.sock, b.dbPath);
  // Zombie A keeps committing and syncing more often than B.
  dbA.exec("CREATE TABLE IF NOT EXISTS owner (who TEXT)");
  const zs: unknown[] = [];
  for (let k = 0; k < 5; k++) {
    dbA.exec("INSERT INTO owner VALUES ('A')");
    for (let i = 0; i < 20; i++) L.insertCommit(dbA, 1000);
    zs.push((await L.syncWait(a.sock, a.dbPath)).json.status);
  }
  for (let i = 0; i < 20; i++) L.insertCommit(dbB, 1000);
  const sB2 = await L.syncWait(b.sock, b.dbPath);
  await L.stop(pA, "SIGTERM");
  await L.stop(pB, "SIGTERM");
  const lastA = (dbA.prepare("SELECT max(seq) m FROM commits").get() as { m: number }).m;
  const lastB = (dbB.prepare("SELECT max(seq) m FROM commits").get() as { m: number }).m;
  dbA.close(); dbB.close();
  const out = join(root, "c.db");
  let r: unknown;
  try {
    await L.restore(null, "file://" + replica, out);
    const v = L.verifyRestored(out);
    const { DatabaseSync } = await import("node:sqlite");
    const c = new DatabaseSync(out, { readOnly: true });
    const owners = (c.prepare("SELECT group_concat(who) w FROM owner").get() as { w: string }).w;
    c.close();
    r = { ...v, owners, equalsA: v.maxSeq === lastA, equalsB: v.maxSeq === lastB };
  } catch (e) {
    r = { restoreError: (e as Error).message.slice(0, 200) };
  }
  results.push({ lastA, lastB, bFirst: sB.json.txid, bLast: sB2.json, zombieSyncs: zs, restore: r });
}
console.log(JSON.stringify(results));
