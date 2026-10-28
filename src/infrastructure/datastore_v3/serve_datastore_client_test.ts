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

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { createHash } from "node:crypto";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";
import { modelPartition } from "../../domain/datastore_v3/v3_test_helpers.ts";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import {
  ChunkHashMismatchError,
  FramedReader,
  ingestChunk,
} from "./chunk_ingest.ts";
import { isNetworkFailure } from "./network_failure.ts";
import {
  COMMIT_CONTENT_TYPE,
  DEFAULT_SERVE_TIMEOUT_MS,
  MAX_HAS_HASHES,
  SERVE_DATASTORE_LOG_HEADER,
  ServeDatastoreClient,
  type ServeDatastoreClientOptions,
  serveRequestTimeoutMs,
} from "./serve_datastore_client.ts";
import {
  ServeAuthFailedError,
  ServePreconditionFailedError,
  ServeRateLimitedError,
  ServeStaleSeqError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";

const BASE = "https://serve.example.com";
const PREFIX = `${BASE}/api/v1/datastore/_default`;

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A client whose fetch is `handler`, recording each request it sent. */
function clientWith(
  handler: (req: Request, call: number) => Response | Promise<Response>,
  options: Partial<ServeDatastoreClientOptions> = {},
): { client: ServeDatastoreClient; requests: Request[] } {
  const requests: Request[] = [];
  const client = new ServeDatastoreClient({
    baseUrl: BASE,
    token: "tok",
    timeoutMs: 5_000,
    ...options,
    fetch: (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      return Promise.resolve(handler(req.clone(), requests.length));
    },
  });
  return { client, requests };
}

const signal = () => new AbortController().signal;

Deno.test("ServeDatastoreClient: normalizes the origin and defaults the namespace to _default", async () => {
  const { client, requests } = clientWith(() => Response.json({ held: [] }));
  const custom = new ServeDatastoreClient({
    baseUrl: "https://SERVE.example.com:443//",
    namespace: "team-a",
    fetch: () => Promise.resolve(Response.json({ held: [] })),
  });
  assertEquals(custom.baseUrl, BASE);
  assertEquals(custom.namespace, "team-a");
  assertEquals(client.namespace, "_default");
  await client.hasChunks(["a".repeat(64)], signal());
  assertEquals(requests[0].url, `${PREFIX}/chunks/has`);
});

Deno.test("ServeDatastoreClient: sends a bearer token only when it has one, beside the extra headers", async () => {
  const withToken = clientWith(() => Response.json({ held: [] }), {
    extraHeaders: { "x-proxy": "p" },
  });
  await withToken.client.hasChunks(["a".repeat(64)], signal());
  assertEquals(
    withToken.requests[0].headers.get("authorization"),
    "Bearer tok",
  );
  assertEquals(withToken.requests[0].headers.get("x-proxy"), "p");
  const without = clientWith(() => Response.json({ held: [] }), {
    token: undefined,
  });
  await without.client.hasChunks(["a".repeat(64)], signal());
  assertEquals(without.requests[0].headers.get("authorization"), null);
});

Deno.test("ServeDatastoreClient.hasChunks: asks at most 1024 hashes a request and unions the answers", async () => {
  const hashes = Array.from(
    { length: 2500 },
    (_, i) => i.toString(16).padStart(64, "0"),
  );
  const { client, requests } = clientWith(async (req) => {
    const { hashes: asked } = await req.json() as { hashes: string[] };
    return Response.json({ held: asked.filter((_, i) => i % 2 === 0) });
  });
  const held = await client.hasChunks([...hashes, hashes[0]], signal());
  assertEquals(requests.length, 3);
  const sizes = await Promise.all(
    requests.map(async (req) =>
      ((await req.json()) as { hashes: string[] }).hashes.length
    ),
  );
  assertEquals(sizes, [MAX_HAS_HASHES, MAX_HAS_HASHES, 2500 - 2 * 1024]);
  assertEquals(requests.every((req) => req.method === "POST"), true);
  assertEquals(held.size, 512 + 512 + 226);
  assert(held.has(hashes[0]));
  assertEquals(held.has(hashes[1]), false);
});

Deno.test("ServeDatastoreClient.hasChunks: sends nothing for no hashes", async () => {
  const { client, requests } = clientWith(() => Response.json({ held: [] }));
  assertEquals((await client.hasChunks([], signal())).size, 0);
  assertEquals(requests.length, 0);
});

Deno.test("ServeDatastoreClient.putChunk: PUTs the bytes, naming the partition", async () => {
  const bytes = new TextEncoder().encode("chunk");
  const hash = sha(bytes);
  const partition = modelPartition();
  const { client, requests } = clientWith(() =>
    Response.json({ sha256: hash, size: bytes.length }, { status: 201 })
  );
  assertEquals(await client.putChunk(hash, bytes, signal(), partition), {
    sha256: hash,
    size: bytes.length,
  });
  const req = requests[0];
  assertEquals(req.method, "PUT");
  const url = new URL(req.url);
  assertEquals(url.pathname, `/api/v1/datastore/_default/chunks/${hash}`);
  assertEquals(url.searchParams.get("partition"), partition.toString());
  assertEquals(new Uint8Array(await req.arrayBuffer()), bytes);
  await client.putChunk(hash, bytes, signal());
  assertEquals(new URL(requests[1].url).searchParams.has("partition"), false);
});

Deno.test("ServeDatastoreClient.getChunk: whole, ranged, missing and unsatisfiable reads", async () => {
  const bytes = new TextEncoder().encode("0123456789");
  const hash = sha(bytes);
  const { client, requests } = clientWith((req) => {
    const range = req.headers.get("range");
    if (req.url.endsWith("f".repeat(64))) {
      return Response.json({ code: "not_found", message: "No such chunk" }, {
        status: 404,
      });
    }
    if (range === "bytes=2-4") {
      return new Response(bytes.slice(2, 5), { status: 206 });
    }
    if (range === "bytes=20-") return new Response(null, { status: 416 });
    return new Response(bytes, { status: 200 });
  });
  assertEquals(await client.getChunk(hash, signal()), bytes);
  assertEquals(requests[0].headers.get("range"), null);
  assertEquals(
    await client.getChunk(hash, signal(), { start: 2, end: 4 }),
    bytes.slice(2, 5),
  );
  assertEquals(await client.getChunk("f".repeat(64), signal()), null);
  const unsatisfiable = await assertRejects(
    () => client.getChunk(hash, signal(), { start: 20 }),
    ServeUpstreamError,
  );
  assertEquals(unsatisfiable.status, 416);
  assertEquals(requests[3].headers.get("range"), "bytes=20-");
});

Deno.test("ServeDatastoreClient.getChunk: a whole chunk that does not hash to its name is refused", async () => {
  const { client } = clientWith(() =>
    new Response(new TextEncoder().encode("other"), { status: 200 })
  );
  await assertRejects(
    () => client.getChunk("a".repeat(64), signal()),
    ChunkHashMismatchError,
  );
});

Deno.test("ServeDatastoreClient.postCommit: frames the envelope and carried chunks as serve reads them", async () => {
  const chunk = new TextEncoder().encode("payload");
  const hash = sha(chunk);
  const partition = modelPartition();
  const txnId = crypto.randomUUID();
  let read: { envelope: unknown; bytes: Uint8Array } | undefined;
  const { client, requests } = clientWith(async (req) => {
    const reader = new FramedReader(req.body!, { maxBytes: 1 << 20 });
    const length = await reader.readUint32BE();
    const envelope = JSON.parse(
      new TextDecoder().decode(await reader.readExactly(length)),
    ) as { chunks: { sha256: string; size: number }[] };
    const verified = await ingestChunk(reader, envelope.chunks[0], {
      maxChunkBytes: CHUNK_BYTES,
    });
    await reader.assertEnd();
    read = { envelope, bytes: verified.bytes };
    return Response.json({ seq: 4, duplicate: true, warning: "w" });
  });
  const reply = await client.postCommit(
    partition,
    { expectedSeq: 3, txnId, fence: 2, ops: [{ kind: "put" }] },
    [{ sha256: hash, bytes: chunk }],
    signal(),
  );
  assertEquals(reply, { seq: 4, duplicate: true, warning: "w" });
  assertEquals(read?.envelope, {
    expectedSeq: 3,
    txnId,
    fence: 2,
    ops: [{ kind: "put" }],
    chunks: [{ sha256: hash, size: chunk.length }],
  });
  assertEquals(read?.bytes, chunk);
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].headers.get("content-type"), COMMIT_CONTENT_TYPE);
  assertEquals(
    requests[0].url,
    `${PREFIX}/partitions/${encodeURIComponent(partition.toString())}/commits`,
  );
});

Deno.test("ServeDatastoreClient.postCommit: an answer without duplicate or warning is a fresh commit", async () => {
  const { client } = clientWith(() => Response.json({ seq: 1 }));
  assertEquals(
    await client.postCommit(
      modelPartition(),
      { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
      [],
      signal(),
    ),
    { seq: 1, duplicate: false },
  );
});

Deno.test("ServeDatastoreClient.postCommit: serve's refusals are thrown as their typed errors", async () => {
  const replies = [
    Response.json({ code: "stale_seq", seq: 8, message: "stale" }, {
      status: 409,
    }),
    Response.json({
      code: "precondition_failed",
      key: "data/x",
      seq: 8,
      message: "Updates were rejected: changed",
    }, { status: 409 }),
    Response.json({ code: "unauthorized", message: "Unauthorized" }, {
      status: 401,
    }),
  ];
  const { client } = clientWith((_, call) => replies[call - 1]);
  const send = () =>
    client.postCommit(
      modelPartition(),
      { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
      [],
      signal(),
    );
  const stale = await assertRejects(send, ServeStaleSeqError);
  assertEquals(stale.seq, 8);
  const precondition = await assertRejects(send, ServePreconditionFailedError);
  assertEquals(precondition.message, "Updates were rejected: changed");
  const auth = await assertRejects(send, ServeAuthFailedError);
  assertEquals(
    auth.message,
    `Authentication failed — run: swamp auth server-login --server ${BASE}`,
  );
});

Deno.test("ServeDatastoreClient.partitionCommits and changes: pass the cursor and limit and return raw commit JSON", async () => {
  const partition = modelPartition();
  const { client, requests } = clientWith((req) =>
    new URL(req.url).pathname.endsWith("/changes")
      ? Response.json({
        changes: [{ cursor: 5, commit: { seq: 1 } }],
        cursor: 7,
        more: true,
      })
      : Response.json({ head: 9, commits: [{ seq: 3 }] })
  );
  assertEquals(await client.partitionCommits(partition, 2, signal(), 50), {
    head: 9,
    commits: [{ seq: 3 }],
  });
  const commitsUrl = new URL(requests[0].url);
  assertEquals(
    [
      commitsUrl.searchParams.get("after"),
      commitsUrl.searchParams.get("limit"),
    ],
    ["2", "50"],
  );
  assertEquals(await client.changes(4, signal()), {
    changes: [{ cursor: 5, commit: { seq: 1 } }],
    cursor: 7,
    more: true,
  });
  const changesUrl = new URL(requests[1].url);
  assertEquals(changesUrl.pathname, "/api/v1/datastore/_default/changes");
  assertEquals(
    [
      changesUrl.searchParams.get("cursor"),
      changesUrl.searchParams.has("limit"),
    ],
    ["4", false],
  );
});

Deno.test("ServeDatastoreClient: a reply missing its fields is refused, not trusted", async () => {
  const { client } = clientWith(() => Response.json({ head: "x" }));
  const error = await assertRejects(
    () => client.partitionCommits(modelPartition(), 0, signal()),
    ServeUpstreamError,
  );
  assertEquals(error.code, "invalid_response");
});

Deno.test("ServeDatastoreClient: a 429 is retried after its Retry-After, then answered", async () => {
  const { client, requests } = clientWith((_, call) =>
    call === 1
      ? Response.json({ code: "rate_limited", message: "Too Many Requests" }, {
        status: 429,
        headers: { "Retry-After": "0" },
      })
      : Response.json({ held: ["a".repeat(64)] })
  );
  assertEquals(
    [...await client.hasChunks(["a".repeat(64)], signal())],
    ["a".repeat(64)],
  );
  assertEquals(requests.length, 2);
});

Deno.test("ServeDatastoreClient: retries are bounded and the wait is capped", async () => {
  const { client, requests } = clientWith(
    () =>
      Response.json({ code: "rate_limited", message: "Too Many Requests" }, {
        status: 429,
        headers: { "Retry-After": "3600" },
      }),
    { maxAttempts: 3, maxRetryDelayMs: 1 },
  );
  const error = await assertRejects(
    () => client.hasChunks(["a".repeat(64)], signal()),
    ServeRateLimitedError,
  );
  assertEquals(requests.length, 3);
  assertEquals(error.retryAfterSeconds, 3600);
});

Deno.test("ServeDatastoreClient: a 429 without Retry-After is not retried", async () => {
  const { client, requests } = clientWith(() =>
    Response.json({
      code: "upload_quota_exceeded",
      message: "Too many uploaded chunks",
    }, { status: 429 })
  );
  const error = await assertRejects(
    () => client.putChunk("a".repeat(64), new Uint8Array(1), signal()),
    ServeRateLimitedError,
  );
  assertEquals(error.code, "upload_quota_exceeded");
  assertEquals(requests.length, 1);
});

Deno.test("ServeDatastoreClient: the caller's abort ends a Retry-After wait", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by caller");
  const { client, requests } = clientWith(() => {
    queueMicrotask(() => controller.abort(reason));
    return Response.json({ code: "rate_limited" }, {
      status: 429,
      headers: { "Retry-After": "3600" },
    });
  }, { maxRetryDelayMs: 3_600_000 });
  const thrown = await assertRejects(() =>
    client.hasChunks(["a".repeat(64)], controller.signal)
  );
  assertStrictEquals(thrown, reason);
  assertEquals(requests.length, 1);
});

/** A client whose fetch throws `error`. */
function failingWith(error: unknown): ServeDatastoreClient {
  return clientWith(() => {
    throw error;
  }).client;
}

const connectRefused = () =>
  new TypeError("fetch failed", {
    cause: new Error(
      "error sending request for url (https://serve.example.com/x): client error (Connect): tcp connect error: Connection refused (os error 61)",
    ),
  });

Deno.test("ServeDatastoreClient: a connection never made is unreachable, never sent", async () => {
  for (
    const error of [
      connectRefused(),
      new TypeError("fetch failed", {
        cause: new Error(
          "error sending request for url (https://serve.example.com/x): client error (Connect): dns error: failed to lookup address information",
        ),
      }),
      new Deno.errors.ConnectionRefused("refused"),
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    ]
  ) {
    const thrown = await assertRejects(
      () => failingWith(error).hasChunks(["a".repeat(64)], signal()),
      ServeUnreachableError,
    );
    assertEquals(thrown.sent, "never");
    assertEquals(thrown.code, "datastore_v3_serve_unreachable");
    assertEquals(thrown.message.includes(BASE), true);
    assertStrictEquals(thrown.cause, error);
    assertEquals(isNetworkFailure(thrown), true);
  }
});

Deno.test("ServeDatastoreClient: a request that may have reached serve is unreachable, maybe sent", async () => {
  for (
    const error of [
      new TypeError("fetch failed", {
        cause: new Error(
          "error sending request from 127.0.0.1:1 for http://127.0.0.1:2/x (127.0.0.1:2): client error (SendRequest): connection closed before message completed",
        ),
      }),
      new TypeError("fetch failed", {
        cause: new Error("Connection reset by peer (os error 54)"),
      }),
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    ]
  ) {
    const thrown = await assertRejects(
      () => failingWith(error).hasChunks(["a".repeat(64)], signal()),
      ServeUnreachableError,
    );
    assertEquals(thrown.sent, "maybe");
    assertEquals(isNetworkFailure(thrown), true);
  }
});

Deno.test("ServeDatastoreClient: a timed-out request is unreachable, maybe sent", async () => {
  const { client } = clientWith(
    (req) =>
      new Promise<Response>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(req.signal.reason));
      }),
    { timeoutMs: 10 },
  );
  const thrown = await assertRejects(
    () => client.changes(0, signal()),
    ServeUnreachableError,
  );
  assertEquals(thrown.sent, "maybe");
});

Deno.test("ServeDatastoreClient: a connection lost while reading the reply is maybe sent", async () => {
  const { client } = clientWith(() =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(
            new Error("error reading a body from connection: reset"),
          );
        },
      }),
      { status: 200 },
    )
  );
  const thrown = await assertRejects(
    () => client.changes(0, signal()),
    ServeUnreachableError,
  );
  assertEquals(thrown.sent, "maybe");
});

Deno.test("ServeDatastoreClient: the caller's abort and a bug are thrown as they are", async () => {
  const controller = new AbortController();
  const reason = new DOMException("stop", "AbortError");
  const { client } = clientWith(() => {
    controller.abort(reason);
    throw reason;
  });
  const aborted = await assertRejects(() =>
    client.changes(0, controller.signal)
  );
  assertStrictEquals(aborted, reason);
  const bug = new TypeError("undefined is not a function");
  const thrown = await assertRejects(() =>
    failingWith(bug).changes(0, signal())
  );
  assertStrictEquals(thrown, bug);
});

Deno.test("ServeDatastoreClient: the HTTP client is made on the first request, once", async () => {
  let made = 0;
  const seen: unknown[] = [];
  const httpClient = Deno.createHttpClient({});
  try {
    const client = new ServeDatastoreClient({
      baseUrl: BASE,
      httpClient: () => {
        made++;
        return httpClient;
      },
      fetch: (_input, init) => {
        seen.push((init as { client?: unknown }).client);
        return Promise.resolve(Response.json({ held: [] }));
      },
    });
    assertEquals(made, 0);
    await client.hasChunks(["a".repeat(64)], signal());
    await client.hasChunks(["b".repeat(64)], signal());
    assertEquals(made, 1);
    assertEquals(seen, [httpClient, httpClient]);
  } finally {
    httpClient.close();
  }
});

Deno.test("serveRequestTimeoutMs: reads SWAMP_SERVE_TIMEOUT_MS, falling back to 30s", () => {
  assertEquals(
    withMockedEnv({ SWAMP_SERVE_TIMEOUT_MS: "1500" }, serveRequestTimeoutMs),
    1500,
  );
  assertEquals(
    withMockedEnv({ SWAMP_SERVE_TIMEOUT_MS: undefined }, serveRequestTimeoutMs),
    DEFAULT_SERVE_TIMEOUT_MS,
  );
  assertEquals(
    withMockedEnv({ SWAMP_SERVE_TIMEOUT_MS: "-4" }, serveRequestTimeoutMs),
    30_000,
  );
});

Deno.test("ServeDatastoreClient: uses the global fetch when none is given", async () => {
  const { calls } = await withMockedFetch(
    [Response.json({ held: ["c".repeat(64)] })],
    async () => {
      const client = new ServeDatastoreClient({ baseUrl: BASE, token: "t" });
      assertEquals(
        [...await client.hasChunks(["c".repeat(64)], signal())],
        ["c".repeat(64)],
      );
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].headers.authorization, "Bearer t");
});

Deno.test("ServeDatastoreClient: over a real connection, a chunk upload carries its Content-Length", async () => {
  const seen: { length: string | null; body: Uint8Array }[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      seen.push({
        length: req.headers.get("content-length"),
        body: new Uint8Array(await req.arrayBuffer()),
      });
      return Response.json({ sha256: "a".repeat(64), size: 3 }, {
        status: 201,
      });
    },
  );
  try {
    const client = new ServeDatastoreClient({
      baseUrl: `http://127.0.0.1:${server.addr.port}`,
    });
    await client.putChunk("a".repeat(64), new Uint8Array([1, 2, 3]), signal());
    assertEquals(seen[0].length, "3");
    assertEquals(seen[0].body, new Uint8Array([1, 2, 3]));
  } finally {
    await server.shutdown();
  }
});

Deno.test("ServeDatastoreClient: a refused connection to a real port is never sent", async () => {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const client = new ServeDatastoreClient({
    baseUrl: `http://127.0.0.1:${port}`,
  });
  const thrown = await assertRejects(
    () => client.changes(0, signal()),
    ServeUnreachableError,
  );
  assertEquals(thrown.sent, "never");
  assertInstanceOf(thrown.cause, Error);
});

Deno.test("ServeDatastoreClient: a port fetch blocks (1) is unreachable, never sent, not a raw TypeError", async () => {
  const client = new ServeDatastoreClient({ baseUrl: "http://127.0.0.1:1" });
  const thrown = await assertRejects(
    () => client.changes(0, signal()),
    ServeUnreachableError,
  );
  assertEquals(thrown.sent, "never");
  assertEquals(thrown.code, "datastore_v3_serve_unreachable");
});

const LOCK_KEY = "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock";
const LEASE = {
  leaseId: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a09",
  lockKey: LOCK_KEY,
  ttlMs: 30_000,
  expiresAt: "2026-10-27T00:00:30.000Z",
};

Deno.test("ServeDatastoreClient.acquireLock: posts the key, TTL and wait, and reads a lease or that the lock is held", async () => {
  const { client, requests } = clientWith((_req, call) =>
    call === 1
      ? Response.json({
        code: "lock_held",
        heldBy: "serve",
        message: "held by serve's own work",
      }, { status: 409 })
      : Response.json(LEASE, { status: 201 })
  );
  assertEquals(await client.acquireLock(LOCK_KEY, 30_000, 2_000, signal()), {
    acquired: false,
    heldBy: "serve",
    message: "held by serve's own work",
  });
  assertEquals(await client.acquireLock(LOCK_KEY, 30_000, 2_000, signal()), {
    acquired: true,
    lease: LEASE,
  });
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].url, `${PREFIX}/locks`);
  assertEquals(await requests[0].json(), {
    lockKey: LOCK_KEY,
    ttlMs: 30_000,
    waitMs: 2_000,
  });
});

Deno.test("ServeDatastoreClient.acquireLock: a refusal is thrown as serve's error", async () => {
  const { client } = clientWith(() =>
    Response.json({ code: "forbidden", message: "needs run" }, {
      status: 403,
    })
  );
  const error = await assertRejects(
    () => client.acquireLock(LOCK_KEY, 30_000, 0, signal()),
    ServeUpstreamError,
  );
  assertEquals(error.code, "forbidden");
});

Deno.test("ServeDatastoreClient.renewLock and releaseLock: a lease serve no longer holds reads as gone, not as an error", async () => {
  const { client, requests } = clientWith((req) =>
    req.url.endsWith("/locks/gone")
      ? Response.json({ code: "lease_not_found", message: "no" }, {
        status: 404,
      })
      : req.method === "DELETE"
      ? Response.json({ released: true })
      : Response.json(LEASE)
  );
  assertEquals(
    await client.renewLock(LEASE.leaseId, 30_000, signal()),
    LEASE,
  );
  assertEquals(await client.renewLock("gone", 30_000, signal()), undefined);
  assertEquals(await client.releaseLock(LEASE.leaseId, signal()), true);
  assertEquals(await client.releaseLock("gone", signal()), false);
  assertEquals(requests[0].method, "PUT");
  assertEquals(requests[0].url, `${PREFIX}/locks/${LEASE.leaseId}`);
  assertEquals(await requests[0].json(), { ttlMs: 30_000 });
  assertEquals(requests[2].method, "DELETE");
});

Deno.test("ServeDatastoreClient.checkLog: every reply's log id is checked before it is read, a success naming none too; a refusal naming none is not", async () => {
  const replies: Response[] = [
    Response.json({ held: [] }, {
      headers: { [SERVE_DATASTORE_LOG_HEADER]: "log-a" },
    }),
    Response.json({ held: [] }),
    Response.json({ code: "not_found", message: "No such" }, { status: 404 }),
    Response.json({ code: "not_found", message: "No such" }, {
      status: 404,
      headers: { [SERVE_DATASTORE_LOG_HEADER]: "log-b" },
    }),
  ];
  const { client } = clientWith((_req, call) => replies[call - 1]);
  const seen: (string | undefined)[] = [];
  client.checkLog((logId) => {
    seen.push(logId);
    if (logId === "log-b") throw new Error("another log");
  });
  const hash = ["a".repeat(64)];

  await client.hasChunks(hash, signal());
  await client.hasChunks(hash, signal());
  const refused = await assertRejects(() => client.hasChunks(hash, signal()));
  assertInstanceOf(refused, ServeUpstreamError);
  await assertRejects(
    () => client.hasChunks(hash, signal()),
    Error,
    "another log",
  );

  assertEquals(seen, ["log-a", undefined, "log-b"]);
});
