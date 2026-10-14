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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  LITESTREAM_TIMEOUT_SLACK_S,
  LitestreamControlError,
  parseResponse,
  unixLitestreamControl,
} from "./litestream_control_client.ts";

const UNIX = Deno.build.os !== "windows";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-ls-ctl-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * A control socket that hands every connection to `answer`: what it writes
 * back, or undefined to accept and never answer (a frozen sidecar).
 */
async function withServer(
  answer: (request: string) => string | undefined,
  fn: (socket: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const socket = join(dir, "ls.sock");
    const listener = Deno.listen({ transport: "unix", path: socket });
    const open: Deno.Conn[] = [];
    const serving = (async () => {
      for await (const conn of listener) {
        open.push(conn);
        const buffer = new Uint8Array(4096);
        const n = await conn.read(buffer).catch(() => null);
        const reply = answer(new TextDecoder().decode(buffer.slice(0, n ?? 0)));
        if (reply === undefined) continue;
        await conn.write(new TextEncoder().encode(reply)).catch(() => {});
        try {
          conn.close();
        } catch {
          // Closed by the client.
        }
      }
    })();
    try {
      await fn(socket);
    } finally {
      listener.close();
      for (const conn of open) {
        try {
          conn.close();
        } catch {
          // Closed already.
        }
      }
      await serving.catch(() => {});
    }
  });
}

function json(status: number, body: unknown): string {
  const text = JSON.stringify(body);
  return `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${text.length}\r\nConnection: close\r\n\r\n${text}`;
}

Deno.test({
  name:
    "unixLitestreamControl.sync: posts the path with wait and returns the answer",
  ignore: !UNIX,
  async fn() {
    let seen = "";
    await withServer((request) => {
      seen = request;
      return json(200, { status: "synced", txid: 3, replicated_txid: 3 });
    }, async (socket) => {
      const answer = await unixLitestreamControl.sync(
        socket,
        "/db/commits.db",
        5_000,
      );
      assertEquals(answer.status, "synced");
      assertEquals(answer.replicated_txid, 3);
    });
    const body = JSON.parse(seen.slice(seen.indexOf("\r\n\r\n") + 4));
    // Litestream's wait outlasts the client's 5 s deadline, so a slow upload
    // ends as a client timeout, never as Litestream's own error answer.
    assertEquals(body, {
      path: "/db/commits.db",
      wait: true,
      timeout: 5 + LITESTREAM_TIMEOUT_SLACK_S,
    });
    assertEquals(seen.startsWith("POST /sync HTTP/1.1"), true);
  },
});

Deno.test({
  name: "unixLitestreamControl.info: reads the pid and version",
  ignore: !UNIX,
  async fn() {
    await withServer(
      () => json(200, { version: "0.5.17", pid: 42 }),
      async (socket) => {
        assertEquals(await unixLitestreamControl.info(socket, 5_000), {
          version: "0.5.17",
          pid: 42,
        });
      },
    );
  },
});

Deno.test({
  name: "unixLitestreamControl.sync: an error answer is a definite failure",
  ignore: !UNIX,
  async fn() {
    await withServer(
      () => json(404, { error: "database not found" }),
      async (socket) => {
        const error = await assertRejects(
          () => unixLitestreamControl.sync(socket, "/db", 5_000),
          LitestreamControlError,
          "database not found",
        );
        assertEquals(error.timedOut, false);
      },
    );
  },
});

Deno.test({
  name:
    "unixLitestreamControl.info: a socket that never answers fails at the deadline",
  ignore: !UNIX,
  async fn() {
    await withServer(() => undefined, async (socket) => {
      const error = await assertRejects(
        () => unixLitestreamControl.info(socket, 100),
        LitestreamControlError,
      );
      assertEquals(error.timedOut, true);
    });
  },
});

Deno.test({
  name: "unixLitestreamControl.info: a missing socket is a definite failure",
  ignore: !UNIX,
  async fn() {
    await withTempDir(async (dir) => {
      const error = await assertRejects(
        () => unixLitestreamControl.info(join(dir, "none.sock"), 1_000),
        LitestreamControlError,
      );
      assertEquals(error.timedOut, false);
    });
  },
});

Deno.test({
  name:
    "unixLitestreamControl.info: a symlink in place of the socket is refused",
  ignore: !UNIX,
  async fn() {
    await withServer(() => json(200, {}), async (socket) => {
      const link = `${socket}.link`;
      await Deno.symlink(socket, link, { type: "file" });
      await assertRejects(
        () => unixLitestreamControl.info(link, 1_000),
        LitestreamControlError,
        "not this user's",
      );
    });
  },
});

Deno.test("parseResponse: reads a chunked body", () => {
  const body = '{"status":"no_change"}';
  const raw = `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n` +
    `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
  assertEquals(parseResponse(new TextEncoder().encode(raw)), {
    status: 200,
    body: { status: "no_change" },
  });
});

Deno.test("parseResponse: rejects a response without headers or JSON", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assertEquals(parseResponse(bytes("HTTP/1.1 204 No\r\n\r\n")).status, 204);
  try {
    parseResponse(bytes("garbage"));
    throw new Error("expected a failure");
  } catch (error) {
    assertEquals(error instanceof LitestreamControlError, true);
  }
  try {
    parseResponse(bytes("HTTP/1.1 200 OK\r\n\r\nnot json"));
    throw new Error("expected a failure");
  } catch (error) {
    assertEquals(error instanceof LitestreamControlError, true);
  }
});

Deno.test("parseResponse: dechunks by bytes, so non-ASCII text survives", () => {
  const body = new TextEncoder().encode(
    '{"error":"database not found: /tmp/caf\u00e9.db"}',
  );
  const head = new TextEncoder().encode(
    `HTTP/1.1 404 X\r\nTransfer-Encoding: chunked\r\n\r\n${
      body.length.toString(16)
    }\r\n`,
  );
  const tail = new TextEncoder().encode("\r\n0\r\n\r\n");
  const raw = new Uint8Array(head.length + body.length + tail.length);
  raw.set(head);
  raw.set(body, head.length);
  raw.set(tail, head.length + body.length);
  assertEquals(parseResponse(raw).body, {
    error: "database not found: /tmp/caf\u00e9.db",
  });
});
