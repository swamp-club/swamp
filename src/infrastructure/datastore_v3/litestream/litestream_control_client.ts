// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
 * Talks to a Litestream sidecar through its control socket (swamp-club#3416):
 * `GET /info` to find a live sidecar and `POST /sync` with `wait` to force
 * the WAL to the replica. HTTP/1.1 over a Unix socket, one request per
 * connection.
 *
 * Every call has a deadline: a frozen sidecar's socket still accepts
 * connections and never answers (Phase 4A saw a command hang there). The
 * socket must belong to this user, so another user who bound the path first
 * cannot answer a sync for it.
 *
 * Windows reaches the socket through `litestream sync` instead; that client
 * waits for a pin of Litestream 0.5.18 or later.
 *
 * @module
 */

import type { LitestreamSyncResponse } from "../../../domain/datastore_v3/litestream_replication.ts";

/** Thrown when a control call fails before Litestream answers it. */
export class LitestreamControlError extends Error {
  constructor(
    message: string,
    /** The deadline passed before an answer: the sidecar may still be working. */
    readonly timedOut: boolean,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LitestreamControlError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** What `GET /info` answers. */
export interface LitestreamInfo {
  readonly version?: string;
  readonly pid?: number;
}

/** A parsed control response. */
export interface ControlResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** The control calls a sidecar answers. */
export interface LitestreamControl {
  info(socketPath: string, deadlineMs: number): Promise<LitestreamInfo>;
  sync(
    socketPath: string,
    dbPath: string,
    deadlineMs: number,
  ): Promise<LitestreamSyncResponse>;
}

/** The control client over Deno's Unix sockets. */
export const unixLitestreamControl: LitestreamControl = {
  async info(socketPath, deadlineMs) {
    const response = await controlRequest(socketPath, "GET", "/info", {
      deadlineMs,
    });
    if (response.status !== 200) {
      throw new LitestreamControlError(
        `GET /info answered ${response.status}`,
        false,
      );
    }
    const { version, pid } = response.body;
    return {
      ...(typeof version === "string" ? { version } : {}),
      ...(typeof pid === "number" ? { pid } : {}),
    };
  },
  async sync(socketPath, dbPath, deadlineMs) {
    const response = await controlRequest(socketPath, "POST", "/sync", {
      deadlineMs,
      // Litestream's own wait ends a little before ours, so its answer, and
      // not a dropped connection, reports a slow upload.
      body: {
        path: dbPath,
        wait: true,
        timeout: Math.max(1, Math.floor(deadlineMs / 1000) - 1),
      },
    });
    if (response.status !== 200) {
      const detail = typeof response.body.error === "string"
        ? `: ${response.body.error}`
        : "";
      throw new LitestreamControlError(
        `POST /sync answered ${response.status}${detail}`,
        false,
      );
    }
    return response.body;
  },
};

/**
 * Sends one request on the control socket at `socketPath` and reads the
 * whole response, failing once `deadlineMs` has passed.
 *
 * @throws LitestreamControlError
 */
export async function controlRequest(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  options: { readonly deadlineMs: number; readonly body?: unknown },
): Promise<ControlResponse> {
  await requireOwnSocket(socketPath);
  const payload = options.body === undefined
    ? new Uint8Array()
    : new TextEncoder().encode(JSON.stringify(options.body));
  let conn: Deno.UnixConn | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Closing the connection ends the read in flight.
      try {
        conn?.close();
      } catch {
        // Closed already.
      }
      reject(
        new LitestreamControlError(
          `${method} ${path} got no answer within ${options.deadlineMs} ms`,
          true,
        ),
      );
    }, options.deadlineMs);
  });
  // The race below handles the rejection; this keeps it from being reported
  // as unhandled when the request settles first.
  expired.catch(() => {});
  try {
    return await Promise.race([
      (async () => {
        try {
          conn = await Deno.connect({ transport: "unix", path: socketPath });
        } catch (error) {
          throw new LitestreamControlError(
            `cannot connect to ${socketPath}: ${messageOf(error)}`,
            false,
            { cause: error },
          );
        }
        const head = `${method} ${path} HTTP/1.1\r\nHost: litestream\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n`;
        try {
          await writeAll(conn, new TextEncoder().encode(head));
          await writeAll(conn, payload);
          return parseResponse(await readAll(conn));
        } catch (error) {
          if (error instanceof LitestreamControlError) throw error;
          throw new LitestreamControlError(
            `${method} ${path} failed: ${messageOf(error)}`,
            false,
            { cause: error },
          );
        }
      })(),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
    try {
      conn?.close();
    } catch {
      // Closed already, by the deadline or the peer.
    }
  }
}

/**
 * Refuses a socket another user owns, or a symlink in its place: only this
 * user's own sidecar may answer for this user's commits.
 */
async function requireOwnSocket(socketPath: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(socketPath);
  } catch (error) {
    throw new LitestreamControlError(
      `no control socket at ${socketPath}`,
      false,
      { cause: error },
    );
  }
  const uid = Deno.uid();
  if (info.isSymlink || (uid !== null && info.uid !== uid)) {
    throw new LitestreamControlError(
      `the control socket at ${socketPath} is not this user's`,
      false,
    );
  }
}

async function writeAll(conn: Deno.UnixConn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

/** Responses are small JSON documents; more than this is not Litestream. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readAll(conn: Deno.UnixConn): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const buffer = new Uint8Array(16 * 1024);
  while (true) {
    const n = await conn.read(buffer);
    if (n === null) break;
    total += n;
    if (total > MAX_RESPONSE_BYTES) {
      throw new LitestreamControlError(
        "the control response is too large",
        false,
      );
    }
    parts.push(buffer.slice(0, n));
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
}

/**
 * Parses an HTTP/1.1 response with a JSON body, sized by Content-Length or
 * chunked.
 */
export function parseResponse(bytes: Uint8Array): ControlResponse {
  const text = new TextDecoder().decode(bytes);
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) {
    throw new LitestreamControlError(
      "the control response has no headers",
      false,
    );
  }
  const head = text.slice(0, split);
  let body = text.slice(split + 4);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
  if (!Number.isInteger(status)) {
    throw new LitestreamControlError(
      "the control response has no status",
      false,
    );
  }
  if (/^transfer-encoding:\s*chunked/im.test(head)) body = dechunk(body);
  let parsed: unknown = {};
  if (body.trim() !== "") {
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new LitestreamControlError(
        "the control response is not JSON",
        false,
        { cause: error },
      );
    }
  }
  return {
    status,
    body: typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {},
  };
}

function dechunk(body: string): string {
  let out = "";
  let at = 0;
  while (at < body.length) {
    const lineEnd = body.indexOf("\r\n", at);
    if (lineEnd < 0) break;
    const size = parseInt(body.slice(at, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    out += body.slice(lineEnd + 2, lineEnd + 2 + size);
    at = lineEnd + 2 + size + 2;
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
