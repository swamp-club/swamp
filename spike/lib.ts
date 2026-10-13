// Spike harness for swamp-club#3234 (Litestream embedding). Throwaway code:
// lives only on spike/3234-litestream, never merged.
import { DatabaseSync } from "node:sqlite";
import { join } from "jsr:@std/path@1";

export const LITESTREAM = Deno.env.get("LITESTREAM_BIN") ?? "litestream";

export type ReplicaSpec =
  | { kind: "file"; path: string }
  | {
    kind: "s3";
    bucket: string;
    path: string;
    endpoint: string;
    region?: string;
  }
  | { kind: "gs"; bucket: string; path: string };

export interface CheckpointRegime {
  /** SQLite's per-connection auto-checkpoint on the app writer; 0 = off. */
  appAutoCheckpoint: number;
}

/** Opens a commits.db-shaped database the way catalog_store.ts does. */
export function openWriter(path: string, regime: CheckpointRegime) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(`PRAGMA wal_autocheckpoint=${regime.appAutoCheckpoint}`);
  db.exec(`CREATE TABLE IF NOT EXISTS commits (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    payload BLOB NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  return db;
}

export function insertCommit(db: DatabaseSync, payloadBytes: number): number {
  const payload = new Uint8Array(payloadBytes);
  crypto.getRandomValues(payload.subarray(0, Math.min(payloadBytes, 65536)));
  const r = db.prepare(
    "INSERT INTO commits (id, payload, created_at) VALUES (?, ?, ?) RETURNING seq",
  ).get(crypto.randomUUID(), payload, Date.now()) as { seq: number };
  return r.seq;
}

export function writeConfig(
  dir: string,
  dbPath: string,
  replica: ReplicaSpec,
  opts: {
    socket: string;
    syncInterval?: string;
    monitorInterval?: string;
    shutdownSyncTimeout?: string;
  },
): string {
  const lines = [
    `socket:`,
    `  enabled: true`,
    `  path: ${opts.socket}`,
    `logging:`,
    `  level: warn`,
    ...(opts.shutdownSyncTimeout
      ? [`shutdown-sync-timeout: ${opts.shutdownSyncTimeout}`]
      : []),
    `dbs:`,
    `  - path: ${dbPath}`,
    ...(opts.monitorInterval
      ? [`    monitor-interval: ${opts.monitorInterval}`]
      : []),
    `    replica:`,
    ...(opts.syncInterval ? [`      sync-interval: ${opts.syncInterval}`] : []),
  ];
  if (replica.kind === "file") {
    lines.push(`      type: file`, `      path: ${replica.path}`);
  } else if (replica.kind === "s3") {
    lines.push(
      `      type: s3`,
      `      bucket: ${replica.bucket}`,
      `      path: ${replica.path}`,
      `      endpoint: ${replica.endpoint}`,
      `      region: ${replica.region ?? "us-east-1"}`,
      `      force-path-style: true`,
    );
  } else {
    lines.push(
      `      type: gs`,
      `      bucket: ${replica.bucket}`,
      `      path: ${replica.path}`,
    );
  }
  const cfg = join(dir, "litestream.yml");
  Deno.writeTextFileSync(cfg, lines.join("\n") + "\n");
  return cfg;
}

export function startReplicate(
  cfg: string,
  env: Record<string, string> = {},
): Deno.ChildProcess {
  return new Deno.Command(LITESTREAM, {
    args: ["replicate", "-config", cfg],
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
}

/** Minimal HTTP/1.1 over the Litestream control socket. */
export async function control(
  socket: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  // Deno has no AF_UNIX client on Windows ("op_net_connect_unix not supported
  // on non-unix platforms"); Litestream's socket works there, so go through
  // curl.exe (shipped with Windows 10 1803+) for the spike.
  if (Deno.build.os === "windows") return await controlViaCurl(socket, method, path, body);
  const conn = await Deno.connect({ transport: "unix", path: socket });
  try {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = `${method} ${path} HTTP/1.1\r\nHost: litestream\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${
        new TextEncoder().encode(payload).length
      }\r\nConnection: close\r\n\r\n${payload}`;
    await conn.write(new TextEncoder().encode(req));
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      chunks.push(buf.slice(0, n));
    }
    const text = new TextDecoder().decode(
      new Uint8Array(chunks.flatMap((c) => [...c])),
    );
    const [head, ...rest] = text.split("\r\n\r\n");
    const status = Number(head.split(" ")[1]);
    let bodyText = rest.join("\r\n\r\n");
    if (/transfer-encoding: chunked/i.test(head)) {
      bodyText = dechunk(bodyText);
    }
    return { status, json: bodyText.trim() ? JSON.parse(bodyText) : {} };
  } finally {
    try {
      conn.close();
    } catch { /* closed */ }
  }
}

async function controlViaCurl(
  socket: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const args = ["-s", "-o", "-", "-w", "\n%{http_code}", "--unix-socket", socket, "-X", method];
  if (body !== undefined) args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
  args.push(`http://litestream${path}`);
  const r = await new Deno.Command("curl", { args }).output();
  if (!r.success) throw new Error(`curl failed: ${r.code}`);
  const text = new TextDecoder().decode(r.stdout);
  const nl = text.lastIndexOf("\n");
  const status = Number(text.slice(nl + 1));
  if (!status) throw new Error("no response");
  const b = text.slice(0, nl).trim();
  return { status, json: b ? JSON.parse(b) : {} };
}

function dechunk(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf("\r\n", i);
    const size = parseInt(s.slice(i, nl), 16);
    if (!size) break;
    out += s.slice(nl + 2, nl + 2 + size);
    i = nl + 2 + size + 2;
  }
  return out;
}

/** Waits until the control socket answers /info. Returns ms waited. */
export async function waitReady(socket: string, timeoutMs = 30000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    try {
      const r = await control(socket, "GET", "/info");
      if (r.status === 200) return performance.now() - t0;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("litestream control socket not ready");
}

export async function syncWait(socket: string, dbPath: string, timeout = 30) {
  return await control(socket, "POST", "/sync", {
    path: dbPath,
    wait: true,
    timeout,
  });
}

export async function restore(
  cfg: string | null,
  replicaUrlOrDb: string,
  out: string,
  env: Record<string, string> = {},
) {
  const args = cfg
    ? ["restore", "-config", cfg, "-o", out, replicaUrlOrDb]
    : ["restore", "-o", out, replicaUrlOrDb];
  const t0 = performance.now();
  const r = await new Deno.Command(LITESTREAM, { args, env }).output();
  const ms = performance.now() - t0;
  if (!r.success) {
    throw new Error(
      `restore failed: ${new TextDecoder().decode(r.stderr)}`,
    );
  }
  return ms;
}

export function verifyRestored(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const ic = db.prepare("PRAGMA integrity_check").get() as Record<
      string,
      string
    >;
    const row = db.prepare(
      "SELECT count(*) AS n, coalesce(max(seq),0) AS maxSeq FROM commits",
    ).get() as { n: number; maxSeq: number };
    return { integrity: Object.values(ic)[0], ...row };
  } finally {
    db.close();
  }
}

export async function stop(p: Deno.ChildProcess, signal: Deno.Signal) {
  const t0 = performance.now();
  try {
    p.kill(signal);
  } catch { /* gone */ }
  const st = await p.status;
  return { ms: performance.now() - t0, code: st.code, signal: st.signal };
}

/** Control socket path. Unix socket paths are limited to ~104 bytes on
 * macOS, so a deep temp dir fails to bind; use a short path outside it. */
export function sockPath(dir: string) {
  return Deno.build.os === "windows"
    ? join(dir, "ls.sock")
    : `/tmp/ls3234-${crypto.randomUUID().slice(0, 8)}.sock`;
}

export function tmpdir(tag: string) {
  return Deno.makeTempDirSync({ prefix: `ls3234-${tag}-` });
}

export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    min: +s[0].toFixed(1),
    p50: +q(0.5).toFixed(1),
    p90: +q(0.9).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
  };
}

/** PRAGMA integrity_check of a restored database of any schema (swamp-club#3357). */
export function verifyIntegrity(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const ic = db.prepare("PRAGMA integrity_check").get() as Record<string, string>;
    return Object.values(ic)[0];
  } finally {
    db.close();
  }
}
