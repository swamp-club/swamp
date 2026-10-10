// S3 (ministack) and GCS (fake-gcs-server) replicate + restore. Usage: smoke_remote.ts s3|gs <port>
import * as L from "./lib.ts";
import { join } from "jsr:@std/path@1";
const [kind, port] = Deno.args;
const d = L.tmpdir(`remote-${kind}`);
const dbPath = join(d, "commits.db");
const db = L.openWriter(dbPath, { appAutoCheckpoint: 1000 });
const sock = L.sockPath(d);
const prefix = `swamp-prefix/_litestream/${crypto.randomUUID()}`;
const spec: L.ReplicaSpec = kind === "s3"
  ? { kind: "s3", bucket: "lsbucket", path: prefix, endpoint: `http://localhost:${port}` }
  : { kind: "gs", bucket: "lsbucket", path: prefix };
const env: Record<string, string> = kind === "s3"
  ? { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" }
  : { STORAGE_EMULATOR_HOST: `localhost:${port}` };
if (kind === "s3" && Deno.env.get("CREDS_URI")) {
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  env.AWS_CONTAINER_CREDENTIALS_FULL_URI = Deno.env.get("CREDS_URI")!;
}
const cfg = L.writeConfig(d, dbPath, spec, { socket: sock });
const p = L.startReplicate(cfg, env);
await L.waitReady(sock);
for (let i = 0; i < 200; i++) L.insertCommit(db, 2048);
const t = performance.now();
const r = await L.syncWait(sock, dbPath);
console.log("sync", r.status, r.json.status, r.json.txid, r.json.replicated_txid, Math.round(performance.now() - t), "ms");
await L.stop(p, "SIGTERM");
db.close();
const out = join(d, "restored.db");
const ms = await L.restore(cfg, dbPath, out, env);
console.log(kind, "restore ms", Math.round(ms), L.verifyRestored(out), "prefix", prefix);
