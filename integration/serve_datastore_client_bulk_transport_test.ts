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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { createHash } from "node:crypto";
import http2 from "node:http2";
import type { TLSSocket } from "node:tls";
import { ServeUpstreamTarget } from "../src/domain/datastore_v3/serve_upstream.ts";
import { modelPartition } from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  ServeDatastoreClient,
  serveDatastoreClientFor,
} from "../src/infrastructure/datastore_v3/serve_datastore_client.ts";
import {
  TEST_CA_PEM,
  TEST_LOCALHOST_CERT_PEM,
  TEST_LOCALHOST_KEY_PEM,
} from "./serve_host_tls_fixture.ts";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly httpVersion: string;
  readonly connection: number;
}

type Handler = (
  req: http2.Http2ServerRequest,
  res: http2.Http2ServerResponse,
  body: Uint8Array,
) => void | Promise<void>;

interface Server extends AsyncDisposable {
  readonly url: string;
  readonly seen: Seen[];
  /** connections by negotiated protocol, and how many are still open */
  readonly connections: { h1: number; h2: number; open: number };
}

// node:http2 is used because it reports each request's HTTP version; it
// offers h2 and http/1.1 over ALPN, as serve's listener does.
async function startServer(handler: Handler): Promise<Server> {
  const seen: Seen[] = [];
  const connections = { h1: 0, h2: 0, open: 0 };
  const ids = new WeakMap<object, number>();
  let next = 0;
  const server = http2.createSecureServer({
    key: TEST_LOCALHOST_KEY_PEM,
    cert: TEST_LOCALHOST_CERT_PEM,
    allowHTTP1: true,
  }, async (req, res) => {
    const parts: Uint8Array[] = [];
    for await (const part of req) parts.push(part as Uint8Array);
    const body = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      body.set(part, offset);
      offset += part.byteLength;
    }
    const socket = req.httpVersion === "2.0"
      ? req.stream.session?.socket
      : req.socket;
    seen.push({
      method: req.method,
      path: new URL(req.url, "https://localhost").pathname,
      httpVersion: req.httpVersion,
      connection: socket === undefined ? -1 : ids.get(socket) ?? -1,
    });
    await handler(req, res, body);
  });
  server.on("secureConnection", (socket: TLSSocket) => {
    ids.set(socket, next++);
    if (socket.alpnProtocol === "h2") connections.h2++;
    else connections.h1++;
    connections.open++;
    socket.on("close", () => connections.open--);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `https://localhost:${port}`,
    seen,
    connections,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: http2.Http2ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signal(): AbortSignal {
  return AbortSignal.timeout(20_000);
}

function answer(
  req: http2.Http2ServerRequest,
  res: http2.Http2ServerResponse,
  body: Uint8Array,
): void {
  const path = new URL(req.url, "https://localhost").pathname;
  if (req.method === "PUT" && path.includes("/chunks/")) {
    json(res, 201, { sha256: path.split("/").pop(), size: body.byteLength });
  } else if (path.endsWith("/chunks/has")) {
    json(res, 200, { held: [] });
  } else if (path.endsWith("/quarantine")) {
    json(res, 200, { duplicate: false });
  } else if (req.method === "POST" && path.endsWith("/commits")) {
    json(res, 200, { seq: 1 });
  } else {
    json(res, 404, { error: { code: "not_found", message: "none" } });
  }
}

function clientFor(url: string): ServeDatastoreClient {
  return serveDatastoreClientFor(
    ServeUpstreamTarget.create({
      serverUrl: url,
      token: "tok",
      caCerts: [TEST_CA_PEM],
    }),
    "_default",
  );
}

Deno.test("serveDatastoreClientFor: bodies that carry chunks go over HTTP/1.1, every other request over HTTP/2", async () => {
  await using server = await startServer(answer);
  const client = clientFor(server.url);
  try {
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const hash = sha(chunk);
    const partition = modelPartition();
    await client.hasChunks([hash], signal());
    await client.getChunk(hash, signal());
    await client.putChunk(hash, chunk, signal(), partition);
    await client.postCommit(
      partition,
      { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
      [{ sha256: hash, bytes: chunk }],
      signal(),
    );
    await client.depositQuarantine(
      {
        commit: { txnId: crypto.randomUUID() },
        base: { seq: 0 },
        chunks: [{ sha256: hash, bytes: chunk }],
      },
      signal(),
    );
  } finally {
    client.close();
  }
  const versionOf = (method: string, suffix: string) =>
    server.seen.find((s) => s.method === method && s.path.endsWith(suffix))
      ?.httpVersion;
  assertEquals(versionOf("POST", "/chunks/has"), "2.0");
  const hash = sha(new Uint8Array(64 * 1024).fill(7));
  assertEquals(versionOf("GET", "/chunks/" + hash), "2.0");
  assertEquals(versionOf("PUT", "/chunks/" + hash), "1.1");
  assertEquals(versionOf("POST", "/commits"), "1.1");
  assertEquals(versionOf("POST", "/quarantine"), "1.1");
});

Deno.test("serveDatastoreClientFor: consecutive commits share one HTTP/1.1 connection, and close leaves none open", async () => {
  await using server = await startServer(answer);
  const client = clientFor(server.url);
  try {
    for (let i = 0; i < 3; i++) {
      const chunk = new Uint8Array(1024).fill(i);
      await client.postCommit(
        modelPartition(),
        { expectedSeq: i, txnId: crypto.randomUUID(), ops: [] },
        [{ sha256: sha(chunk), bytes: chunk }],
        signal(),
      );
    }
    await client.hasChunks(["a".repeat(64)], signal());
  } finally {
    client.close();
  }
  const commits = server.seen.filter((s) => s.path.endsWith("/commits"));
  assertEquals(commits.length, 3);
  assertEquals(new Set(commits.map((s) => s.connection)).size, 1);
  assertEquals(server.connections.h1, 1);
  assertEquals(server.connections.h2, 1);
  // under the server's own idle close (~5 s), which would hide a leaked client
  await waitFor(
    () => server.connections.open === 0,
    "every connection closed",
    {
      timeoutMs: 2_000,
    },
  );
});

Deno.test("ServeDatastoreClient: a node refusing as not serving retires the bulk connection too, after its in-flight upload finishes there", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => release = resolve);
  let holdNext = true;
  await using server = await startServer(async (req, res, body) => {
    const path = new URL(req.url, "https://localhost").pathname;
    if (path.endsWith("/chunks/has")) {
      json(res, 503, { error: { code: "serve_unavailable", message: "x" } });
      return;
    }
    if (req.method === "PUT" && holdNext) {
      holdNext = false;
      await held;
    }
    answer(req, res, body);
  });
  const client = new ServeDatastoreClient({
    baseUrl: server.url,
    token: "tok",
    maxAttempts: 1,
    httpClient: () => Deno.createHttpClient({ caCerts: [TEST_CA_PEM] }),
    bulkHttpClient: () =>
      Deno.createHttpClient({
        http1: true,
        http2: false,
        caCerts: [TEST_CA_PEM],
      }),
  });
  try {
    const partition = modelPartition();
    const first = new Uint8Array(1024).fill(1);
    const uploading = client.putChunk(sha(first), first, signal(), partition);
    await waitFor(
      () => server.seen.some((s) => s.method === "PUT"),
      "the held upload reached serve",
    );
    await client.hasChunks(["a".repeat(64)], signal()).catch(() => {});
    release();
    assertEquals((await uploading).size, first.byteLength);
    const second = new Uint8Array(1024).fill(2);
    await client.putChunk(sha(second), second, signal(), partition);
  } finally {
    client.close();
  }
  const puts = server.seen.filter((s) => s.method === "PUT");
  assertEquals(puts.length, 2);
  assert(puts[0].connection !== puts[1].connection);
  assertEquals(server.connections.h1, 2);
});

Deno.test("serveDatastoreClientFor: Deno.serve takes a commit with a large body over the HTTP/1.1 client", async () => {
  let received: { length: string | null; bytes: number } | undefined;
  await using server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    cert: TEST_LOCALHOST_CERT_PEM,
    key: TEST_LOCALHOST_KEY_PEM,
    onListen: () => {},
  }, async (req) => {
    const bytes = (await req.arrayBuffer()).byteLength;
    received = { length: req.headers.get("content-length"), bytes };
    return Response.json({ seq: 1 });
  });
  const client = clientFor(`https://localhost:${server.addr.port}`);
  try {
    const chunk = new Uint8Array(4 * 1024 * 1024).fill(9);
    const reply = await client.postCommit(
      modelPartition(),
      { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
      [{ sha256: sha(chunk), bytes: chunk }],
      signal(),
    );
    assertEquals(reply.seq, 1);
  } finally {
    client.close();
  }
  assert(received !== undefined);
  assertEquals(Number(received.length), received.bytes);
  assert(received.bytes > 4 * 1024 * 1024);
});
