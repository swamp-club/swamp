// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

/**
 * SPIKE ONLY (swamp-club#3357), never merged: replicates a v3 datastore's
 * commits.db with a Litestream sidecar, so whole write commands can be timed.
 *
 * Off unless SWAMP_SPIKE_LITESTREAM is set:
 * - `percommand`: the writer starts a sidecar when it takes the writer lock,
 *   and at teardown waits for it, forces one `/sync {wait:true}`, and stops it.
 * - `idle`: the writer reuses a sidecar found through a pidfile and its
 *   socket, or starts a detached one. The sidecar runs `-exec` on a watcher
 *   that exits once the pidfile has gone untouched for the idle timeout, and
 *   Litestream then shuts down (with its own final sync).
 *
 * SWAMP_SPIKE_LITESTREAM_BIN     litestream binary
 * SWAMP_SPIKE_LITESTREAM_REPLICA JSON: {type:"s3"|"gs"|"file", bucket?, path, endpoint?}
 * SWAMP_SPIKE_LITESTREAM_IDLE_S  idle timeout, seconds (default 30)
 * SWAMP_SPIKE_LITESTREAM_LOG     append one JSON line of phase timings per command
 */

import { join } from "@std/path";

interface Replica {
  type: "s3" | "gs" | "file";
  bucket?: string;
  path: string;
  endpoint?: string;
}

interface Active {
  dbPath: string;
  socket: string;
  child?: Deno.ChildProcess;
  pidfile?: string;
  startedAt: number;
  reused: boolean;
  startMs: number;
}

const active = new Map<string, Active>();
const t0 = performance.now();

function mode(): "percommand" | "idle" | undefined {
  const m = Deno.env.get("SWAMP_SPIKE_LITESTREAM");
  return m === "percommand" || m === "idle" ? m : undefined;
}

function config(dbPath: string, socket: string, replica: Replica): string {
  const lines = [
    "socket:",
    "  enabled: true",
    `  path: ${socket}`,
    "logging:",
    `  level: ${Deno.env.get("SWAMP_SPIKE_LITESTREAM_LOGLEVEL") ?? "warn"}`,
    "dbs:",
    `  - path: ${dbPath}`,
    "    replica:",
    `      type: ${replica.type}`,
    `      path: ${replica.path}`,
  ];
  if (replica.bucket) lines.push(`      bucket: ${replica.bucket}`);
  if (replica.type === "s3") {
    lines.push(
      `      endpoint: ${replica.endpoint}`,
      "      region: us-east-1",
      "      force-path-style: true",
    );
  }
  return lines.join("\n") + "\n";
}

async function hash8(s: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(d)].slice(0, 4)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Minimal HTTP/1.1 over the control socket. */
async function control(
  socket: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const conn = await Deno.connect({ transport: "unix", path: socket });
  try {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = `${method} ${path} HTTP/1.1\r\nHost: litestream\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${
        new TextEncoder().encode(payload).length
      }\r\nConnection: close\r\n\r\n${payload}`;
    await conn.write(new TextEncoder().encode(req));
    const parts: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      parts.push(buf.slice(0, n));
    }
    const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    const text = new TextDecoder().decode(all);
    const [head, ...rest] = text.split("\r\n\r\n");
    let bodyText = rest.join("\r\n\r\n");
    if (/transfer-encoding: chunked/i.test(head)) {
      let out = "";
      let i = 0;
      while (i < bodyText.length) {
        const nl = bodyText.indexOf("\r\n", i);
        const size = parseInt(bodyText.slice(i, nl), 16);
        if (!size) break;
        out += bodyText.slice(nl + 2, nl + 2 + size);
        i = nl + 2 + size + 2;
      }
      bodyText = out;
    }
    return {
      status: Number(head.split(" ")[1]),
      json: bodyText.trim() ? JSON.parse(bodyText) : {},
    };
  } finally {
    try {
      conn.close();
    } catch { /* closed */ }
  }
}

async function answers(socket: string): Promise<boolean> {
  try {
    const r = await control(socket, "GET", "/info");
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitReady(socket: string, timeoutMs = 30_000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (await answers(socket)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("litestream control socket not ready");
}

/** Called when this process takes the v3 writer lock on `datastorePath`. */
export async function spikeLitestreamStart(
  datastorePath: string,
): Promise<void> {
  const m = mode();
  if (m === undefined || active.has(datastorePath)) return;
  const start = performance.now();
  const bin = Deno.env.get("SWAMP_SPIKE_LITESTREAM_BIN") ?? "litestream";
  const replica = JSON.parse(
    Deno.env.get("SWAMP_SPIKE_LITESTREAM_REPLICA") ?? "{}",
  ) as Replica;
  const dbPath = join(datastorePath, "commits.db");
  const h = await hash8(dbPath);
  const socket = `/tmp/ls3357-${h}.sock`;
  const dir = join(Deno.env.get("HOME") ?? "/tmp", ".swamp", "spike-litestream");
  await Deno.mkdir(dir, { recursive: true });
  const cfg = join(dir, `${h}.yml`);
  await Deno.writeTextFile(cfg, config(dbPath, socket, replica));
  if (m === "percommand") {
    const child = new Deno.Command(bin, {
      args: ["replicate", "-config", cfg],
      stdin: "null",
      stdout: "null",
      stderr: "inherit",
    }).spawn();
    active.set(datastorePath, {
      dbPath,
      socket,
      child,
      startedAt: start,
      reused: false,
      startMs: performance.now() - start,
    });
    return;
  }
  // idle: reuse a live sidecar, or start a detached one.
  const pidfile = join(dir, `${h}.pid`);
  const now = new Date();
  let reused = false;
  if (await answers(socket)) {
    reused = true;
    await Deno.utime(pidfile, now, now).catch(() => {});
  } else {
    await Deno.remove(socket).catch(() => {});
    await Deno.writeTextFile(pidfile, "");
    const idle = Number(Deno.env.get("SWAMP_SPIKE_LITESTREAM_IDLE_S") ?? 30);
    // The watcher exits once the pidfile is older than the idle timeout;
    // Litestream's -exec then stops replication and exits.
    // A script file, so no outer shell expands it at spawn time.
    const watcher = join(dir, `${h}.watch.sh`);
    await Deno.writeTextFile(
      watcher,
      `while [ $(( $(date +%s) - $(stat -f %m ${pidfile}) )) -lt ${idle} ]; do sleep 1; done\n`,
    );
    const sh = `nohup ${bin} replicate -config ${cfg} -exec "sh ${watcher}" ` +
      `>/dev/null 2>&1 & echo $! > ${pidfile}`;
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", sh],
      stdin: "null",
      stdout: "null",
      stderr: "inherit",
    }).output();
    if (!out.success) throw new Error("could not start idle sidecar");
  }
  active.set(datastorePath, {
    dbPath,
    socket,
    pidfile,
    startedAt: start,
    reused,
    startMs: performance.now() - start,
  });
}

/**
 * Called at teardown after the closing compaction and before the writer lock
 * is released: one forced sync covers every commit this command made.
 */
export async function spikeLitestreamSyncAll(): Promise<void> {
  const all = [...active.values()];
  active.clear();
  for (const a of all) await syncOne(a);
}

async function syncOne(a: Active): Promise<void> {
  const w0 = performance.now();
  await waitReady(a.socket);
  const w1 = performance.now();
  const s = await control(a.socket, "POST", "/sync", {
    path: a.dbPath,
    wait: true,
    timeout: 60,
  });
  const w2 = performance.now();
  if (s.status !== 200 || s.json.status !== "synced") {
    throw new Error(`litestream sync failed: ${JSON.stringify(s)}`);
  }
  let stopMs = 0;
  if (a.child) {
    a.child.kill("SIGTERM");
    await a.child.status;
    stopMs = performance.now() - w2;
  } else if (a.pidfile) {
    const now = new Date();
    await Deno.utime(a.pidfile, now, now).catch(() => {});
  }
  const log = Deno.env.get("SWAMP_SPIKE_LITESTREAM_LOG");
  if (log) {
    await Deno.writeTextFile(
      log,
      JSON.stringify({
        mode: mode(),
        reused: a.reused,
        startMs: a.startMs,
        commandMsBeforeSync: w0 - a.startedAt,
        readyWaitMs: w1 - w0,
        syncMs: w2 - w1,
        stopMs,
        sinceProcessStartMs: performance.now() - t0,
      }) + "\n",
      { append: true },
    );
  }
}
