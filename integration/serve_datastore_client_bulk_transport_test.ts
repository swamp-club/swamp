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
import { ServeUpstreamTarget } from "../src/domain/datastore_v3/serve_upstream.ts";
import { modelPartition } from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  BULK_MIN_BODY_BYTES,
  bulkHttpClientOptions,
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
  req: Request,
  body: Uint8Array,
) => Response | Promise<Response>;

interface Server extends AsyncDisposable {
  readonly url: string;
  readonly seen: Seen[];
  /** connections by negotiated protocol, and how many are still open */
  readonly connections: { h1: number; h2: number; open: number };
}

// a TLS front offers h2 and http/1.1 over ALPN, as serve's listener does, and
// records each connection's protocol before piping it to a cleartext Deno.serve
function startServer(handler: Handler): Server {
  const seen: Seen[] = [];
  const connections = { h1: 0, h2: 0, open: 0 };
  // the backend sees each front connection as its own client port
  const fronts = new Map<number, { id: number; httpVersion: string }>();
  let next = 0;
  const backend = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (req, info) => {
    const body = new Uint8Array(await req.arrayBuffer());
    const front = fronts.get(info.remoteAddr.port);
    seen.push({
      method: req.method,
      path: new URL(req.url).pathname,
      httpVersion: front?.httpVersion ?? "unknown",
      connection: front?.id ?? -1,
    });
    return await handler(req, body);
  });
  const listener = Deno.listenTls({
    hostname: "127.0.0.1",
    port: 0,
    cert: TEST_LOCALHOST_CERT_PEM,
    key: TEST_LOCALHOST_KEY_PEM,
    alpnProtocols: ["h2", "http/1.1"],
  });
  const open = new Set<Deno.Conn>();
  const pumps = new Set<Promise<void>>();
  const relay = async (tls: Deno.TlsConn): Promise<void> => {
    connections.open++;
    let up: Deno.TcpConn | undefined;
    try {
      const { alpnProtocol } = await tls.handshake();
      const httpVersion = alpnProtocol === "h2" ? "2.0" : "1.1";
      if (httpVersion === "2.0") connections.h2++;
      else connections.h1++;
      up = await Deno.connect({
        hostname: "127.0.0.1",
        port: backend.addr.port,
      });
      fronts.set(up.localAddr.port, { id: next++, httpVersion });
      open.add(up);
      // either side ending ends the connection, so neither leg waits on the other
      await Promise.race([
        tls.readable.pipeTo(up.writable),
        up.readable.pipeTo(tls.writable),
      ]).catch(() => {});
    } catch {
      // a client that hangs up mid-handshake leaves nothing to relay
    } finally {
      for (const conn of [tls, up]) {
        if (conn === undefined) continue;
        open.delete(conn);
        try {
          conn.close();
        } catch {
          // already closed by the pipe that ended
        }
      }
      connections.open--;
    }
  };
  const accepting = (async () => {
    for await (const tls of listener) {
      open.add(tls);
      const pump = relay(tls);
      pumps.add(pump);
      pump.finally(() => pumps.delete(pump));
    }
  })().catch(() => {});
  return {
    url: `https://localhost:${listener.addr.port}`,
    seen,
    connections,
    async [Symbol.asyncDispose]() {
      listener.close();
      await accepting;
      for (const conn of open) {
        try {
          conn.close();
        } catch {
          // already closed by its relay
        }
      }
      await Promise.allSettled([...pumps]);
      await backend.shutdown();
    },
  };
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signal(): AbortSignal {
  return AbortSignal.timeout(20_000);
}

function answer(req: Request, body: Uint8Array): Response {
  const path = new URL(req.url).pathname;
  if (req.method === "PUT" && path.includes("/chunks/")) {
    return json(201, { sha256: path.split("/").pop(), size: body.byteLength });
  } else if (path.endsWith("/chunks/has")) {
    return json(200, { held: [] });
  } else if (path.endsWith("/quarantine")) {
    return json(200, { duplicate: false });
  } else if (req.method === "POST" && path.includes("/partitions/")) {
    return json(200, { seq: 1 });
  } else if (req.method === "POST" && path.endsWith("/commits")) {
    const header = new DataView(body.buffer, body.byteOffset).getUint32(0);
    const { items } = JSON.parse(
      new TextDecoder().decode(body.subarray(4, 4 + header)),
    ) as { items: unknown[] };
    return json(200, {
      results: items.map(() => ({ status: 200, body: { seq: 1 } })),
    });
  }
  return json(404, { error: { code: "not_found", message: "none" } });
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

Deno.test("serveDatastoreClientFor: a body carrying BULK_MIN_BODY_BYTES of chunks goes over HTTP/1.1, every other request over HTTP/2, a small chunked commit included", async () => {
  await using server = startServer(answer);
  const client = clientFor(server.url);
  const chunk = new Uint8Array(BULK_MIN_BODY_BYTES).fill(7);
  const hash = sha(chunk);
  const small = new Uint8Array(BULK_MIN_BODY_BYTES / 4).fill(8);
  const smallHash = sha(small);
  const under = chunk.subarray(1);
  const underHash = sha(under);
  const partition = modelPartition();
  const carried = [{ sha256: hash, bytes: chunk }];
  const carriedSmall = [{ sha256: smallHash, bytes: small }];
  const envelope = () => ({
    expectedSeq: 0,
    txnId: crypto.randomUUID(),
    ops: [],
  });
  const deposit = (chunks: typeof carried) => ({
    commit: { txnId: crypto.randomUUID() },
    base: { seq: 0 },
    chunks,
  });
  const calls: [string, string, () => Promise<unknown>][] = [
    ["chunks/has", "2.0", () => client.hasChunks([hash], signal())],
    ["chunk read", "2.0", () => client.getChunk(hash, signal())],
    [
      "chunk upload",
      "1.1",
      () => client.putChunk(hash, chunk, signal(), partition),
    ],
    [
      "commit with chunks",
      "1.1",
      () => client.postCommit(partition, envelope(), carried, signal()),
    ],
    [
      "chunkless commit",
      "2.0",
      () => client.postCommit(partition, envelope(), [], signal()),
    ],
    [
      "commit with a small chunk",
      "2.0",
      () => client.postCommit(partition, envelope(), carriedSmall, signal()),
    ],
    [
      "small chunk upload",
      "2.0",
      () => client.putChunk(smallHash, small, signal(), partition),
    ],
    [
      "chunk upload a byte under the threshold",
      "2.0",
      () => client.putChunk(underHash, under, signal(), partition),
    ],
    ["batch with chunks", "1.1", () =>
      client.postCommits(
        [
          { partition, envelope: envelope(), chunks: [] },
          { partition, envelope: envelope(), chunks: carried },
        ],
        undefined,
        signal(),
      )],
    ["chunkless batch", "2.0", () =>
      client.postCommits(
        [{ partition, envelope: envelope(), chunks: [] }],
        undefined,
        signal(),
      )],
    [
      "deposit with chunks",
      "1.1",
      () => client.depositQuarantine(deposit(carried), signal()),
    ],
    [
      "chunkless deposit",
      "2.0",
      () => client.depositQuarantine(deposit([]), signal()),
    ],
    [
      "deposit with a small chunk",
      "2.0",
      () => client.depositQuarantine(deposit(carriedSmall), signal()),
    ],
  ];
  const versions: Record<string, string | undefined> = {};
  try {
    for (const [name, , call] of calls) {
      const before = server.seen.length;
      await call();
      assertEquals(server.seen.length, before + 1, name);
      versions[name] = server.seen[before].httpVersion;
    }
  } finally {
    client.close();
  }
  assertEquals(
    versions,
    Object.fromEntries(calls.map(([name, version]) => [name, version])),
  );
});

Deno.test("ServeDatastoreClient: consecutive large commits share one HTTP/1.1 client, and close leaves no connection open", async () => {
  await using server = startServer(answer);
  let bulkClients = 0;
  const client = new ServeDatastoreClient({
    baseUrl: server.url,
    namespace: "_default",
    token: "tok",
    httpClient: () => Deno.createHttpClient({ caCerts: [TEST_CA_PEM] }),
    bulkHttpClient: () => {
      bulkClients++;
      return Deno.createHttpClient(bulkHttpClientOptions([TEST_CA_PEM]));
    },
  });
  try {
    for (let i = 0; i < 3; i++) {
      const chunk = new Uint8Array(BULK_MIN_BODY_BYTES).fill(i);
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
  assertEquals(commits.map((s) => s.httpVersion), ["1.1", "1.1", "1.1"]);
  // the pool may open a second connection before the first is back in it
  assertEquals(bulkClients, 1);
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
  await using server = startServer(async (req, body) => {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/chunks/has")) {
      return json(503, {
        error: { code: "serve_unavailable", message: "x" },
      });
    }
    if (req.method === "PUT" && holdNext) {
      holdNext = false;
      await held;
    }
    return answer(req, body);
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
    const first = new Uint8Array(BULK_MIN_BODY_BYTES).fill(1);
    const uploading = client.putChunk(sha(first), first, signal(), partition);
    await waitFor(
      () => server.seen.some((s) => s.method === "PUT"),
      "the held upload reached serve",
    );
    await client.hasChunks(["a".repeat(64)], signal()).catch(() => {});
    release();
    assertEquals((await uploading).size, first.byteLength);
    const second = new Uint8Array(BULK_MIN_BODY_BYTES).fill(2);
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
