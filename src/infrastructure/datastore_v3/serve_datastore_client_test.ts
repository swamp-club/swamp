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

import { waitFor } from "@swamp-club/swamp-testing";
import {
  SERVE_FOLLOWER_BEHIND_CODE,
  SERVE_NOT_LEADER_CODE,
  ServeFollowerBehindError,
  ServeNotLeaderError,
} from "../../domain/datastore_v3/serve_leader.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { createHash } from "node:crypto";
import { CHUNK_BYTES } from "../../domain/datastore_v3/chunk_store.ts";
import { MAX_COMMIT_OPS } from "../../domain/datastore_v3/commit.ts";
import { MAX_FIELD_LENGTH as MAX_INTENT_FIELD_LENGTH } from "../../domain/datastore_v3/intent.ts";
import { MAX_INLINE_BYTES, putOp } from "../../domain/datastore_v3/op.ts";
import {
  MAX_RECORD_KEY_LENGTH,
  RecordKey,
} from "../../domain/datastore_v3/record_key.ts";
import {
  modelIntent,
  modelPartition,
  savePut,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import { findSpan, withCapturedSpans } from "../tracing/span_test_helpers.ts";
import {
  ChunkHashMismatchError,
  FramedReader,
  ingestChunk,
} from "./chunk_ingest.ts";
import { isNetworkFailure } from "./network_failure.ts";
import {
  clearServeUnreachableLatches,
  COMMIT_CONTENT_TYPE,
  DEFAULT_SERVE_TIMEOUT_MS,
  latchServeUnreachable,
  MAX_HAS_HASHES,
  MAX_PUT_OP_REPLY_BYTES,
  MAX_WRITTEN_COMMIT_REPLY_BYTES,
  MIN_SERVE_UPLOAD_BYTES_PER_SECOND,
  resetHeardServeRepliesForTesting,
  routeTemplate,
  SERVE_DATASTORE_ACCESS_HEADER,
  SERVE_DATASTORE_LOG_HEADER,
  SERVE_ERROR_BODY_MAX_BYTES,
  SERVE_LEASE_REPLY_MAX_BYTES,
  SERVE_PAGE_MAX_BYTES,
  SERVE_REPLY_MAX_BYTES,
  ServeDatastoreClient,
  type ServeDatastoreClientOptions,
  serveRequestDeadlineMs,
  serveRequestTimeoutMs,
  serveResponseDeadlineMs,
} from "./serve_datastore_client.ts";
import {
  ServeAuthFailedError,
  ServeLeaseLapsedLatch,
  ServeLeaseLapsedRequestError,
  ServePreconditionFailedError,
  ServeRateLimitedError,
  ServeReplyTooLargeError,
  ServeStaleSeqError,
  ServeUnreachableError,
  ServeUpstreamError,
} from "./serve_upstream_errors.ts";
import { LEASE_LAPSED_CODE } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  isLapsedServeRequest,
  V3_SERVE_UNREACHABLE_CODE,
} from "../../domain/datastore_v3/writer_lease.ts";
import { serveStamped } from "./serve_upstream_test_helpers.ts";

const BASE = "https://serve.example.com";
const PREFIX = `${BASE}/api/v1/datastore/_default`;

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

/** a lock request names a fresh id each time; checked on its own */
function withoutRequestId(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { requestId, ...rest } = body;
  assert(typeof requestId === "string" && requestId.length > 0);
  return rest;
}

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

Deno.test("ServeDatastoreClient: names its request span in a traceparent, so serve's spans join the member's trace", async () => {
  await withCapturedSpans(async (spans) => {
    const { client, requests } = clientWith(() => Response.json({ held: [] }));
    await client.hasChunks(["a".repeat(64)], signal());
    const span = findSpan(spans, "swamp.datastore.v3.serve.request");
    const context = span.spanContext();
    assertEquals(
      requests[0].headers.get("traceparent"),
      `00-${context.traceId}-${context.spanId}-01`,
    );
  });
});

Deno.test("ServeDatastoreClient: sends no traceparent when nothing is traced", async () => {
  const { client, requests } = clientWith(() => Response.json({ held: [] }));
  await client.hasChunks(["a".repeat(64)], signal());
  assertEquals(requests[0].headers.get("traceparent"), null);
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

Deno.test("ServeDatastoreClient.getChunk: a read serve could not decide is a refusal, never a missing chunk (swamp-club#4260)", async () => {
  const { client } = clientWith(() =>
    Response.json({
      code: "chunk_access_undecided",
      message: "Whether this chunk may be read could not be decided",
    }, { status: 503 })
  );
  const refused = await assertRejects(
    () => client.getChunk("a".repeat(64), signal()),
    ServeUpstreamError,
  );
  assertEquals(refused.status, 503);
  assertEquals(refused.code, "chunk_access_undecided");
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

Deno.test("serveRequestDeadlineMs: adds the body's bytes at the floor upload rate to the flat timeout", () => {
  assertEquals(serveRequestDeadlineMs(30_000, 0), 30_000);
  assertEquals(
    serveRequestDeadlineMs(30_000, MIN_SERVE_UPLOAD_BYTES_PER_SECOND),
    31_000,
  );
  // 128 MiB, a 64 MiB output stored as result and log
  assertEquals(serveRequestDeadlineMs(30_000, 128 * 1024 * 1024), 542_000);
});

Deno.test("ServeDatastoreClient: a request's deadline grows with the bytes it uploads; a bodiless one keeps the flat timeout", async () => {
  const deadlines: number[] = [];
  const chunk = new Uint8Array(2 * MIN_SERVE_UPLOAD_BYTES_PER_SECOND);
  const hash = sha(chunk);
  const { client } = clientWith(
    (req) =>
      req.method === "PUT"
        ? Response.json({ sha256: hash, size: chunk.length })
        : new Response(chunk),
    {
      timeoutMs: 5_000,
      timeoutSignal: (ms) => {
        deadlines.push(ms);
        return new AbortController().signal;
      },
    },
  );
  await client.putChunk(hash, chunk, signal());
  await client.getChunk(hash, signal());
  assertEquals(deadlines, [7_000, 5_000]);
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

Deno.test("ServeDatastoreClient.partitionCommits: names the seq the copy holds only when given one (swamp-club#4254)", async () => {
  const { client, requests } = clientWith(() =>
    Response.json({ head: 3, commits: [] })
  );
  await client.partitionCommits(modelPartition(), 2, signal(), 1, 3);
  await client.partitionCommits(modelPartition(), 0, signal(), 10, 0);
  await client.partitionCommits(modelPartition(), 0, signal());
  assertEquals(
    requests.map((req) => new URL(req.url).searchParams.get("held")),
    ["3", null, null],
  );
});

Deno.test("ServeDatastoreClient: a follower behind the copy is a retryable refusal, not divergence (swamp-club#4254)", async () => {
  clearServeUnreachableLatches();
  const { client } = clientWith(() =>
    Response.json(
      { code: SERVE_FOLLOWER_BEHIND_CODE, message: "behind" },
      { status: 503, headers: { "Retry-After": "1" } },
    ), { readRefusalBudgetMs: 0 });
  const error = await assertRejects(
    () => client.partitionCommits(modelPartition(), 2, signal(), 1, 3),
    ServeFollowerBehindError,
  );
  assertEquals(error.code, SERVE_FOLLOWER_BEHIND_CODE);
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
  assertEquals(withoutRequestId(await requests[0].json()), {
    lockKey: LOCK_KEY,
    ttlMs: 30_000,
    waitMs: 2_000,
    fenced: true,
  });
});

Deno.test("ServeDatastoreClient.acquireLock: a fenced lease's fence, floor and hold are read, and an explicit lease asks for its hold (swamp-club#4121)", async () => {
  const fenced = {
    ...LEASE,
    fence: 4,
    floor: [{ name: "vpc", highWater: 3, removed: [[1, 1] as const] }],
    holdMs: 600_000,
  };
  const { client, requests } = clientWith(() =>
    Response.json(fenced, { status: 201 })
  );
  assertEquals(
    await client.acquireLock(LOCK_KEY, 30_000, 0, signal(), {
      holdMs: 600_000,
    }),
    { acquired: true, lease: fenced },
  );
  assertEquals(withoutRequestId(await requests[0].json()), {
    lockKey: LOCK_KEY,
    waitMs: 0,
    fenced: true,
    holdMs: 600_000,
  });
});

Deno.test("ServeDatastoreClient.acquireLock: a malformed floor is refused", async () => {
  const { client } = clientWith(() =>
    Response.json({ ...LEASE, fence: 1, floor: [{ name: "" }] }, {
      status: 201,
    })
  );
  await assertRejects(
    () => client.acquireLock(LOCK_KEY, 30_000, 0, signal()),
    ServeUpstreamError,
  );
});

Deno.test("ServeDatastoreClient.acquireLock: a floor past the small reply limit is read (swamp-club#4166)", async () => {
  const floor = Array.from({ length: 15_000 }, (_, i) => ({
    name: `aws-ec2-instance-${String(i).padStart(6, "0")}-us-east-1-production`,
    highWater: 1,
  }));
  const fenced = { ...LEASE, fence: 1, floor };
  const reply = JSON.stringify(fenced);
  assert(reply.length > SERVE_REPLY_MAX_BYTES, `${reply.length} bytes`);
  const { client } = clientWith(() => new Response(reply, { status: 201 }));
  assertEquals(await client.acquireLock(LOCK_KEY, 30_000, 0, signal()), {
    acquired: true,
    lease: fenced,
  });
});

Deno.test("ServeDatastoreClient.acquireLock: a lease past its limit is refused and cancelled (swamp-club#4166)", async () => {
  const body = counted(
    SERVE_LEASE_REPLY_MAX_BYTES + 2 * PIECE,
    0x20,
    new TextEncoder().encode("{"),
  );
  const { client } = clientWith(() =>
    new Response(body.stream, { status: 201 })
  );
  const error = await assertRejects(
    () => client.acquireLock(LOCK_KEY, 30_000, 0, signal()),
    ServeReplyTooLargeError,
  );
  assertEquals(error.maxBytes, SERVE_LEASE_REPLY_MAX_BYTES);
  assertBounded(body, SERVE_LEASE_REPLY_MAX_BYTES);
});

Deno.test("ServeDatastoreClient.renewLock: a renewal past the small reply limit is refused, as it carries no floor (swamp-club#4166)", async () => {
  const body = counted(
    SERVE_REPLY_MAX_BYTES + 2 * PIECE,
    0x20,
    new TextEncoder().encode("{"),
  );
  const { client } = clientWith(() => new Response(body.stream));
  const error = await assertRejects(
    () => client.renewLock(LEASE.leaseId, 30_000, signal()),
    ServeReplyTooLargeError,
  );
  assertEquals(error.maxBytes, SERVE_REPLY_MAX_BYTES);
  assertBounded(body, SERVE_REPLY_MAX_BYTES);
});

Deno.test("ServeDatastoreClient.listLocks: reads serve's listing, and an older serve's 405 is no listing (swamp-club#4121)", async () => {
  const listing = {
    leases: [{
      lockKey: LOCK_KEY,
      heldBy: "other" as const,
      expiresAt: "2026-10-29T12:00:30.000Z",
    }],
    truncated: false,
  };
  const { client, requests } = clientWith(() => Response.json(listing));
  assertEquals(await client.listLocks("data/", signal()), listing);
  assertEquals(requests[0].url, `${PREFIX}/locks?prefix=data%2F`);
  const older = clientWith(() => new Response("no", { status: 405 })).client;
  assertEquals(await older.listLocks("", signal()), undefined);
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

Deno.test("ServeDatastoreClient.checkAccess: every reply naming the caller's read access reports it once the log check passed, a refusal too; one naming none does not (swamp-club#4089)", async () => {
  const replies: Response[] = [
    Response.json({ held: [] }, {
      headers: {
        [SERVE_DATASTORE_LOG_HEADER]: "log-a",
        [SERVE_DATASTORE_ACCESS_HEADER]: "a1",
      },
    }),
    Response.json({ held: [] }, {
      headers: { [SERVE_DATASTORE_LOG_HEADER]: "log-a" },
    }),
    Response.json({ code: "not_found", message: "No such" }, {
      status: 404,
      headers: {
        [SERVE_DATASTORE_LOG_HEADER]: "log-a",
        [SERVE_DATASTORE_ACCESS_HEADER]: "b2",
      },
    }),
    Response.json({ held: [] }, {
      headers: {
        [SERVE_DATASTORE_LOG_HEADER]: "log-b",
        [SERVE_DATASTORE_ACCESS_HEADER]: "c3",
      },
    }),
  ];
  const { client } = clientWith((_req, call) => replies[call - 1]);
  client.checkLog((logId) => {
    if (logId === "log-b") throw new Error("another log");
  });
  const seen: string[] = [];
  client.checkAccess((fingerprint) => seen.push(fingerprint));
  const hash = ["a".repeat(64)];

  await client.hasChunks(hash, signal());
  await client.hasChunks(hash, signal());
  await assertRejects(() => client.hasChunks(hash, signal()));
  await assertRejects(
    () => client.hasChunks(hash, signal()),
    Error,
    "another log",
  );

  assertEquals(seen, ["a1", "b2"]);
});

const PIECE = 256 * 1024;

function counted(total: number, fill = 0x20, prefix = new Uint8Array()) {
  let handed = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (handed === 0 && prefix.byteLength > 0) {
        handed = prefix.byteLength;
        controller.enqueue(prefix);
        return;
      }
      if (handed >= total) {
        controller.close();
        return;
      }
      const n = Math.min(PIECE, total - handed);
      handed += n;
      controller.enqueue(new Uint8Array(n).fill(fill));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, handed: () => handed, cancelled: () => cancelled };
}

function paddedPage(total: number) {
  const json = new TextEncoder().encode('{"head":0,"commits":[]}');
  return counted(total, 0x20, json);
}

function assertBounded(body: ReturnType<typeof counted>, maxBytes: number) {
  assert(
    body.handed() <= maxBytes + PIECE,
    `read ${body.handed()} bytes of a ${maxBytes}-byte limit`,
  );
  assert(body.cancelled(), "the body is cancelled");
}

Deno.test("ServeDatastoreClient.getChunk: a body past the largest chunk is refused and cancelled, whatever Content-Length says", async () => {
  const lengths: Record<string, string>[] = [{}, { "content-length": "10" }];
  for (const headers of lengths) {
    const body = counted(CHUNK_BYTES + 2 * PIECE);
    const { client } = clientWith(() =>
      new Response(body.stream, { status: 200, headers })
    );
    const error = await assertRejects(
      () => client.getChunk("a".repeat(64), signal()),
      ServeReplyTooLargeError,
    );
    assertEquals(error.maxBytes, CHUNK_BYTES);
    assertEquals(error.code, "reply_too_large");
    assertBounded(body, CHUNK_BYTES);
  }
});

Deno.test("ServeDatastoreClient.getChunk: a 206 is held to the range asked, a 200 to the largest chunk", async () => {
  const longer = counted(101);
  const { client } = clientWith(() =>
    new Response(longer.stream, { status: 206 })
  );
  const error = await assertRejects(
    () => client.getChunk("a".repeat(64), signal(), { start: 0, end: 99 }),
    ServeReplyTooLargeError,
  );
  assertEquals(error.maxBytes, 100);

  const whole = new Uint8Array(CHUNK_BYTES).fill(7);
  const { client: ignoring } = clientWith(() =>
    new Response(whole, { status: 200 })
  );
  assertEquals(
    (await ignoring.getChunk(sha(whole), signal(), { start: 0, end: 99 }))
      ?.byteLength,
    CHUNK_BYTES,
  );
});

Deno.test("ServeDatastoreClient.changes and partitionCommits: a page past its limit is refused and cancelled, and one at it reads", async () => {
  const overLimit = paddedPage(SERVE_PAGE_MAX_BYTES + 1);
  const { client } = clientWith(() =>
    new Response(overLimit.stream, {
      status: 200,
      headers: { "content-length": "23" },
    })
  );
  const error = await assertRejects(
    () => client.partitionCommits(modelPartition(), 0, signal(), 1000),
    ServeReplyTooLargeError,
  );
  assertEquals(error.maxBytes, SERVE_PAGE_MAX_BYTES);
  assertBounded(overLimit, SERVE_PAGE_MAX_BYTES);

  const atLimit = paddedPage(SERVE_PAGE_MAX_BYTES);
  const { client: real } = clientWith(() =>
    new Response(atLimit.stream, { status: 200 })
  );
  assertEquals(await real.partitionCommits(modelPartition(), 0, signal(), 2), {
    head: 0,
    commits: [],
  });

  const feed = counted(SERVE_PAGE_MAX_BYTES + 2 * PIECE);
  const { client: oversized } = clientWith(() =>
    new Response(feed.stream, { status: 200 })
  );
  await assertRejects(
    () => oversized.changes(0, signal(), 1000),
    ServeReplyTooLargeError,
  );
  assertBounded(feed, SERVE_PAGE_MAX_BYTES);
});

Deno.test("ServeDatastoreClient.partitionCommits: a page of one commit may pass the page limit, up to the largest commit serve writes", async () => {
  const pastPage = paddedPage(SERVE_PAGE_MAX_BYTES + 1);
  const { client } = clientWith(() =>
    new Response(pastPage.stream, { status: 200 })
  );
  assertEquals(
    await client.partitionCommits(modelPartition(), 0, signal(), 1),
    {
      head: 0,
      commits: [],
    },
  );
  assert(MAX_WRITTEN_COMMIT_REPLY_BYTES > SERVE_PAGE_MAX_BYTES);
});

Deno.test("ServeDatastoreClient.changes: a page of 1000 typical commits reads", async () => {
  const commit = serveStamped(1, [await savePut("m", 1)], modelPartition())
    .toJSON();
  const page = {
    changes: Array.from({ length: 1000 }, (_, i) => ({
      cursor: i + 1,
      commit: { ...commit, seq: i + 1 },
    })),
    cursor: 1000,
    more: false,
  };
  const { client } = clientWith(() => Response.json(page));
  assertEquals((await client.changes(0, signal(), 1000)).changes.length, 1000);
});

Deno.test("MAX_WRITTEN_COMMIT_REPLY_BYTES: a page of the largest commit serve's unit of work writes fits it", async () => {
  const wide = "€";
  const longest = wide.repeat(MAX_INTENT_FIELD_LENGTH);
  const prefix = `data/x/${MAX_COMMIT_OPS}/`;
  const op = await putOp({
    intent: modelIntent({ kind: "data.rename", name: longest, to: longest }),
    key: RecordKey.create(
      prefix + wide.repeat(MAX_RECORD_KEY_LENGTH - prefix.length),
    ),
    inline: btoa("\xff".repeat(MAX_INLINE_BYTES)),
    expect: { sha256: "a".repeat(64) },
  });
  const opBytes = new TextEncoder().encode(JSON.stringify(op.toJSON()))
    .byteLength;
  assert(opBytes <= MAX_PUT_OP_REPLY_BYTES, `${opBytes} bytes`);
  const empty = new TextEncoder().encode(
    JSON.stringify({
      head: 1,
      commits: [serveStamped(1, [op], modelPartition()).toJSON()],
    }),
  ).byteLength - opBytes;
  const page = empty + MAX_COMMIT_OPS * (opBytes + 1);
  assert(
    page <= MAX_WRITTEN_COMMIT_REPLY_BYTES,
    `${page} bytes against ${MAX_WRITTEN_COMMIT_REPLY_BYTES}`,
  );
});

Deno.test("ServeDatastoreClient: a small JSON reply past its limit is refused", async () => {
  const body = counted(SERVE_REPLY_MAX_BYTES + 2 * PIECE);
  const { client } = clientWith(() => new Response(body.stream));
  const error = await assertRejects(
    () => client.hasChunks(["a".repeat(64)], signal()),
    ServeReplyTooLargeError,
  );
  assertEquals(error.maxBytes, SERVE_REPLY_MAX_BYTES);
  assertBounded(body, SERVE_REPLY_MAX_BYTES);
});

Deno.test("ServeDatastoreClient: an error body past its limit maps from the status alone", async () => {
  for (
    const send of [
      (c: ServeDatastoreClient) => c.changes(0, signal()),
      (c: ServeDatastoreClient) => c.acquireLock(LOCK_KEY, 30_000, 0, signal()),
    ]
  ) {
    const body = counted(
      SERVE_ERROR_BODY_MAX_BYTES + 2 * PIECE,
      0x20,
      new TextEncoder().encode('{"code":'),
    );
    const { client } = clientWith(() =>
      new Response(body.stream, { status: 409 })
    );
    const error = await assertRejects(() => send(client), ServeUpstreamError);
    assert(!(error instanceof ServeReplyTooLargeError));
    assertEquals(error.status, 409);
    assertEquals(error.message, `Serve at ${BASE} answered HTTP 409`);
    assertBounded(body, SERVE_ERROR_BODY_MAX_BYTES);
  }
});

Deno.test("ServeDatastoreClient: a connection lost while reading an error body is still maybe sent", async () => {
  const { client } = clientWith(() =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(
            new Error("error reading a body from connection: reset"),
          );
        },
      }),
      { status: 500 },
    )
  );
  const thrown = await assertRejects(
    () => client.changes(0, signal()),
    ServeUnreachableError,
  );
  assertEquals(thrown.sent, "maybe");
});

Deno.test("ServeDatastoreClient.compactedBase: passes the token and limit and reads each entry", async () => {
  const partition = modelPartition().toString();
  const entry = {
    kind: "partition" as const,
    namespace: "ns",
    partition,
    seq: 2,
    names: [],
  };
  const { client, requests } = clientWith(() =>
    Response.json({ point: 9, entries: [entry], next: "tok-2" })
  );
  assertEquals(await client.compactedBase("tok-1", "ns", signal(), 50), {
    point: 9,
    entries: [entry],
    next: "tok-2",
  });
  const url = new URL(requests[0].url);
  assertEquals(url.pathname, "/api/v1/datastore/_default/base");
  assertEquals(
    [url.searchParams.get("after"), url.searchParams.get("limit")],
    ["tok-1", "50"],
  );

  const { client: last, requests: first } = clientWith(() =>
    Response.json({ point: 9, entries: [] })
  );
  assertEquals(
    (await last.compactedBase(undefined, "ns", signal())).next,
    undefined,
  );
  assertEquals(new URL(first[0].url).searchParams.has("after"), false);
});

Deno.test("ServeDatastoreClient.compactedBase: an entry of another namespace or shape refuses the whole page", async () => {
  const partition = modelPartition().toString();
  const replies = [
    {
      point: 9,
      entries: [{
        kind: "partition",
        namespace: "other",
        partition,
        seq: 1,
        names: [],
      }],
    },
    { point: 9, entries: [{ kind: "commit", namespace: "ns" }] },
    { point: "9", entries: [] },
    { point: 9, entries: [], next: "" },
  ];
  for (const reply of replies) {
    const { client } = clientWith(() => Response.json(reply));
    const error = await assertRejects(
      () => client.compactedBase(undefined, "ns", signal()),
      ServeUpstreamError,
    );
    assertEquals(error.code, "invalid_response", JSON.stringify(reply));
  }
});

Deno.test("ServeDatastoreClient.compactedBase: a page past its limit is refused and cancelled", async () => {
  const feed = counted(SERVE_PAGE_MAX_BYTES + 2 * PIECE);
  const { client } = clientWith(() =>
    new Response(feed.stream, { status: 200 })
  );
  const error = await assertRejects(
    () => client.compactedBase(undefined, "ns", signal(), 1000),
    ServeReplyTooLargeError,
  );
  assertEquals(error.maxBytes, SERVE_PAGE_MAX_BYTES);
  assertBounded(feed, SERVE_PAGE_MAX_BYTES);
});

Deno.test("ServeDatastoreClient.compactedBase: the log id is checked before the page is read", async () => {
  const { client } = clientWith(() =>
    Response.json({ point: 9, entries: [] }, {
      headers: { [SERVE_DATASTORE_LOG_HEADER]: "log-b" },
    })
  );
  const seen: (string | undefined)[] = [];
  client.checkLog((logId) => {
    seen.push(logId);
    if (logId !== "log-a") throw new Error("another log");
  });
  await assertRejects(
    () => client.compactedBase(undefined, "ns", signal()),
    Error,
    "another log",
  );
  assertEquals(seen, ["log-b"]);
});

Deno.test("ServeDatastoreClient: every request names the lease ops and step starts its copy understands (swamp-club#4121)", async () => {
  const { client, requests } = clientWith(() =>
    Response.json({ head: 0, commits: [] })
  );
  await client.partitionCommits(modelPartition(), 0, signal(), 10);
  assertEquals(
    requests[0].headers.get("x-swamp-datastore-features"),
    "lease-ops,step-starts",
  );
});

Deno.test("ServeDatastoreClient.takesStepStarts: true only once serve's reply names step starts", async () => {
  let features: string | undefined;
  const { client } = clientWith(() =>
    Response.json({ head: 0, commits: [] }, {
      headers: {
        "x-swamp-datastore-log": "log-a",
        ...(features === undefined
          ? {}
          : { "x-swamp-datastore-features": features }),
      },
    })
  );
  assertEquals(client.takesStepStarts(), false);
  await client.partitionCommits(modelPartition(), 0, signal(), 10);
  assertEquals(client.takesStepStarts(), false);
  features = "step-starts";
  await client.partitionCommits(modelPartition(), 0, signal(), 10);
  assertEquals(client.takesStepStarts(), true);
  features = undefined;
  await client.partitionCommits(modelPartition(), 0, signal(), 10);
  assertEquals(client.takesStepStarts(), false);
});

Deno.test("routeTemplate: a span's route names the kind of resource, never its id", () => {
  const sha = "a".repeat(64);
  assertEquals(
    [
      "changes",
      "base",
      "locks",
      "quarantine",
      "chunks/has",
      `chunks/${sha}`,
      "locks/lease-1",
      `partitions/${encodeURIComponent("model:aws/vpc:prod")}/commits`,
      "quarantine/txn-1/accept",
    ].map(routeTemplate),
    [
      "changes",
      "base",
      "locks",
      "quarantine",
      "chunks/has",
      "chunks/{sha256}",
      "locks/{leaseId}",
      "partitions/{partition}/commits",
      "quarantine/{txnId}/accept",
    ],
  );
});

Deno.test("ServeDatastoreClient: once a write latched serve unreachable, a request in flight ends maybe sent and the next fails at once, until the command ends", async () => {
  let pending = 0;
  const { client, requests } = clientWith((req) => {
    pending++;
    return new Promise<Response>((_, reject) => {
      req.signal.addEventListener("abort", () => reject(req.signal.reason));
    });
  });
  try {
    const inFlight = assertRejects(
      () => client.changes(0, signal()),
      ServeUnreachableError,
    );
    await waitFor(() => pending === 1, "the request to be sent");
    latchServeUnreachable(client.baseUrl, new Error("a commit timed out"));
    assertEquals((await inFlight).sent, "maybe");

    const next = await assertRejects(
      () => client.changes(0, signal()),
      ServeUnreachableError,
    );
    assertEquals(next.sent, "never");
    assertEquals(requests.length, 1, "nothing more was sent");
  } finally {
    clearServeUnreachableLatches();
  }
  const fresh = clientWith(() => Response.json({ changes: [], head: 0 }));
  await fresh.client.changes(0, signal()).catch(() => {});
  assertEquals(fresh.requests.length, 1, "a new command asks serve again");
});

Deno.test("ServeDatastoreClient: a lease that lapsed unrenewed ends a request in flight as the lapse, naming the request and its size, and the next as never sent", async () => {
  let pending = 0;
  const chunk = new Uint8Array(2 * 1024 * 1024);
  const { client, requests } = clientWith((req) => {
    pending++;
    return new Promise<Response>((_, reject) => {
      req.signal.addEventListener("abort", () => reject(req.signal.reason));
    });
  });
  try {
    const inFlight = assertRejects(
      () => client.putChunk(sha(chunk), chunk, signal()),
      ServeLeaseLapsedRequestError,
    );
    await waitFor(() => pending === 1, "the upload to be sent");
    latchServeUnreachable(
      client.baseUrl,
      new ServeLeaseLapsedLatch("model aws/vpc prod"),
    );
    const lapsed = await inFlight;
    assertInstanceOf(lapsed, ServeUnreachableError);
    assertEquals(lapsed.code, LEASE_LAPSED_CODE);
    assertEquals(lapsed.sent, "maybe");
    assert(isLapsedServeRequest(lapsed));
    assertStringIncludes(
      lapsed.message,
      "lease on model aws/vpc prod at serve lapsed unrenewed while an upload of 2.0 MiB (PUT chunks/{sha256})",
    );
    assertStringIncludes(lapsed.message, "The change is kept");

    const next = await assertRejects(
      () => client.changes(0, signal()),
      ServeLeaseLapsedRequestError,
    );
    assertEquals(next.sent, "never");
    assertStringIncludes(next.message, "a request (GET changes) was not sent");
    assertEquals(requests.length, 1, "nothing more was sent");
  } finally {
    clearServeUnreachableLatches();
  }
});

Deno.test("ServeDatastoreClient: a latch that is not a lapse keeps the unreachable code", async () => {
  try {
    const { client } = clientWith(() => Response.json({}));
    latchServeUnreachable(client.baseUrl, new Error("a commit timed out"));
    const error = await assertRejects(
      () => client.changes(0, signal()),
      ServeUnreachableError,
    );
    assertEquals(error.code, V3_SERVE_UNREACHABLE_CODE);
    assertEquals(isLapsedServeRequest(error), false);
  } finally {
    clearServeUnreachableLatches();
  }
});

Deno.test("ServeDatastoreClient: a dedicated HTTP client is made once, on first use, and closed by close()", async () => {
  let made = 0;
  let closed = 0;
  const { client } = clientWith(
    () => Response.json({ changes: [], head: 0 }),
    {
      httpClient: () => {
        made++;
        const http = Deno.createHttpClient({});
        const close = http.close.bind(http);
        http.close = () => {
          closed++;
          close();
        };
        return http;
      },
    },
  );
  for (let i = 0; i < 3; i++) {
    await client.changes(0, signal()).catch(() => {});
  }
  assertEquals(made, 1);
  client.close();
  assertEquals(closed, 1);
});

Deno.test("ServeDatastoreClient.initiatorMode: read from serve's replies that carry its log, decoded, and never from a reply without", async () => {
  // what other clients of this process heard is shared; this one starts fresh
  resetHeardServeRepliesForTesting();
  let reply: () => Response = () => Response.json({ head: 0, commits: [] });
  const { client } = clientWith(() => reply());
  assertEquals(client.initiatorMode(), undefined);

  const withLog = (headers: Record<string, string>) => () =>
    Response.json({ head: 0, commits: [] }, {
      headers: { "x-swamp-datastore-log": "log-a", ...headers },
    });

  reply = withLog({ "x-swamp-datastore-features": "step-starts" });
  await client.partitionCommits(modelPartition(), 0, signal(), 10);
  assertEquals(client.initiatorMode(), { kind: "not-checked" });

  reply = withLog({
    "x-swamp-datastore-features": "step-starts,run-initiator",
    "x-swamp-datastore-principal": encodeURIComponent("user:zoë"),
  });
  await client.partitionCommits(modelPartition(), 0, signal(), 10);
  assertEquals(client.initiatorMode(), {
    kind: "checked",
    principal: "user:zoë",
  });

  // a reply with no log header (a refusal before serve answered) says nothing
  reply = () =>
    Response.json({ code: "unauthorized", message: "no" }, { status: 401 });
  await assertRejects(() =>
    client.partitionCommits(modelPartition(), 0, signal(), 10)
  );
  assertEquals(client.initiatorMode(), {
    kind: "checked",
    principal: "user:zoë",
  });

  // the check advertised with no principal is no check this client can meet
  reply = withLog({ "x-swamp-datastore-features": "run-initiator" });
  await client.partitionCommits(modelPartition(), 0, signal(), 10);
  assertEquals(client.initiatorMode(), { kind: "not-checked" });
});

Deno.test("ServeDatastoreClient.initiatorMode: a 401 or 403 reply never names the principal, even with serve's log and principal headers (swamp-club#4512)", async () => {
  for (const status of [401, 403]) {
    resetHeardServeRepliesForTesting();
    const { client } = clientWith(() =>
      Response.json({ code: "refused", message: "no" }, {
        status,
        headers: {
          "x-swamp-datastore-log": "log-a",
          "x-swamp-datastore-features": "run-initiator",
          "x-swamp-datastore-principal": encodeURIComponent("user:caller"),
        },
      })
    );
    await assertRejects(() =>
      client.partitionCommits(modelPartition(), 0, signal(), 10)
    );
    assertEquals(client.initiatorMode(), undefined, String(status));
  }
});

Deno.test("ServeDatastoreClient.acquireLock: a held reply's holder is read, and the budget is sent from the first ask", async () => {
  const holder = {
    principal: "user:boss",
    explicit: true,
    expiresAt: "2026-11-06T10:00:00.000Z",
  };
  const { client, requests } = clientWith(() =>
    Response.json({
      code: "lock_held",
      heldBy: "other",
      message: "held",
      holder,
    }, { status: 409 })
  );
  const first = await client.acquireLock(LOCK_KEY, 30_000, 2_000, signal(), {
    budgetMs: 50_000,
  });
  assertEquals(first, {
    acquired: false,
    heldBy: "other",
    message: "held",
    holder,
  });
  assertEquals((await requests[0].json()).budgetMs, 50_000);
});

Deno.test("ServeDatastoreClient: a held reply or listing without a holder (an older serve) still reads, and a malformed holder is left out", async () => {
  const { client } = clientWith((_req, call) =>
    call === 1
      ? Response.json({
        code: "lock_held",
        heldBy: "other",
        message: "held",
        holder: { principal: 7 },
      }, { status: 409 })
      : Response.json({
        leases: [{
          lockKey: LOCK_KEY,
          heldBy: "other",
          expiresAt: "2026-10-29T12:00:30.000Z",
          holder: {
            principal: "user:boss",
            explicit: true,
            expiresAt: "2026-10-29T12:00:30.000Z",
          },
        }],
        truncated: false,
      })
  );
  assertEquals(await client.acquireLock(LOCK_KEY, 30_000, 2_000, signal()), {
    acquired: false,
    heldBy: "other",
    message: "held",
  });
  const listing = await client.listLocks("data/", signal());
  assertEquals(listing?.leases[0].holder, {
    principal: "user:boss",
    explicit: true,
    expiresAt: "2026-10-29T12:00:30.000Z",
  });
});

Deno.test("ServeDatastoreClient.authorizeRemovals: reads a verdict per commit, and an older serve without the route is no answer", async () => {
  const { client, requests } = clientWith(() =>
    Response.json({
      verdicts: [{ ok: true }, {
        ok: false,
        reason: "forbidden",
        message: "Not authorized to write model:web (definition.delete)",
      }],
    })
  );
  const commit = { partition: modelPartition(), ops: [] };
  assertEquals(
    await client.authorizeRemovals([commit, commit], signal()),
    [{ ok: true }, {
      ok: false,
      reason: "forbidden",
      message: "Not authorized to write model:web (definition.delete)",
    }],
  );
  assertEquals(requests[0].url, `${PREFIX}/authorize`);
  const older = clientWith(() => new Response("no", { status: 404 })).client;
  assertEquals(await older.authorizeRemovals([commit], signal()), undefined);
});

Deno.test("ServeDatastoreClient.postCommits: maps each result as its single reply would be, and pads what serve did not try", async () => {
  const commit = {
    partition: modelPartition(),
    envelope: { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
    chunks: [],
  };
  const { client, requests } = clientWith(() =>
    Response.json({
      results: [
        { status: 200, body: { seq: 1, commit: { seq: 1 }, parentTxnId: "p" } },
        { status: 409, body: { code: "stale_seq", seq: 4, message: "stale" } },
      ],
      released: false,
    })
  );
  const reply = await client.postCommits(
    [commit, commit, commit],
    "lease-1",
    signal(),
  );
  assertEquals(new URL(requests[0].url).pathname.endsWith("/commits"), true);
  assertEquals(reply.released, false);
  assertEquals(reply.outcomes.map((outcome) => outcome.kind), [
    "landed",
    "refused",
    "not-tried",
  ]);
  const landed = reply.outcomes[0];
  assertEquals(
    landed.kind === "landed" ? landed.reply.parentTxnId : undefined,
    "p",
  );
  const refused = reply.outcomes[1];
  assertEquals(
    refused.kind === "refused" ? refused.error.constructor.name : "",
    "ServeStaleSeqError",
  );
});

Deno.test("ServeDatastoreClient.postCommits: a reply naming more results than commits sent, or one without a status, is refused", async () => {
  const commit = {
    partition: modelPartition(),
    envelope: { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
    chunks: [],
  };
  for (
    const results of [[{ status: 200, body: { seq: 1 } }, {
      status: 200,
      body: { seq: 2 },
    }], [{ body: {} }]]
  ) {
    const { client } = clientWith(() => Response.json({ results }));
    await assertRejects(() =>
      client.postCommits([commit], undefined, signal())
    );
  }
});

Deno.test("ServeDatastoreClient: a lock's catch-up and a changes page's anchor verdict are read when well formed and dropped when not", async () => {
  const requested = { cursor: 3 };
  for (
    const [catchUp, expected] of [
      [
        {
          requested,
          changes: [],
          cursor: 5,
          more: false,
          anchor: { verdict: "behind", serveHead: 2 },
        },
        { verdict: "behind", serveHead: 2 },
      ],
      [{ requested, changes: "not a list", cursor: 5, more: false }, undefined],
      [{ changes: [], cursor: 5, more: false }, undefined],
    ] as const
  ) {
    const { client } = clientWith(() =>
      Response.json({
        leaseId: "l",
        lockKey: "k",
        ttlMs: 1000,
        expiresAt: new Date().toISOString(),
        catchUp,
      }, { status: 201 })
    );
    const reply = await client.acquireLock("k", 1000, 0, signal(), {
      catchUp: requested,
    });
    assert(reply.acquired);
    assertEquals(
      reply.acquired ? reply.catchUp?.page?.anchor : "unacquired",
      expected,
    );
  }
  const { client } = clientWith(() =>
    Response.json({
      changes: [],
      cursor: 1,
      more: false,
      anchor: { verdict: "other-commit" },
    })
  );
  // an other-commit verdict naming no txnId is not trusted
  assertEquals((await client.changes(0, signal())).anchor, undefined);
});

// a reply serve never starts: the request ends only when its signal aborts
function neverAnswered(req: Request): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    req.signal.addEventListener("abort", () => reject(req.signal.reason));
  });
}

const neverTimesOut = () => new AbortController().signal;

Deno.test("serveResponseDeadlineMs: the base plus the wait asked of serve and the upload allowance, never past the whole deadline", () => {
  assertEquals(serveResponseDeadlineMs(10_000, 30_000, 0, 0), 10_000);
  assertEquals(serveResponseDeadlineMs(10_000, 30_000, 0, 10_000), 20_000);
  assertEquals(
    serveResponseDeadlineMs(
      10_000,
      30_000,
      MIN_SERVE_UPLOAD_BYTES_PER_SECOND,
      0,
    ),
    11_000,
  );
  assertEquals(serveResponseDeadlineMs(10_000, 30_000, 0, 60_000), 30_000);
  // a lower SWAMP_SERVE_TIMEOUT_MS lowers the base with it
  assertEquals(serveResponseDeadlineMs(10_000, 4_000, 0, 0), 4_000);
});

Deno.test("ServeDatastoreClient: a reply serve never starts ends at the response deadline, not the request timeout", async () => {
  const { client } = clientWith(neverAnswered, {
    responseBaseMs: 20,
    commitResponseBaseMs: 20,
    timeoutSignal: neverTimesOut,
  });
  try {
    const thrown = await assertRejects(
      () =>
        client.postCommit(
          modelPartition(),
          { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
          [],
          signal(),
        ),
      ServeUnreachableError,
    );
    assertEquals(thrown.sent, "maybe");
    assertStringIncludes(String(thrown.cause), "did not start its reply");
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient: a read serve never answers is sent once more on a fresh connection", async () => {
  let made = 0;
  const used: unknown[] = [];
  const client = new ServeDatastoreClient({
    baseUrl: BASE,
    responseBaseMs: 20,
    timeoutSignal: neverTimesOut,
    httpClient: () => {
      made++;
      return Deno.createHttpClient({});
    },
    fetch: (input, init) => {
      used.push((init as { client?: unknown }).client);
      return used.length === 1
        ? neverAnswered(new Request(input, init))
        : Promise.resolve(
          Response.json({ changes: [], cursor: 0, more: false }),
        );
    },
  });
  try {
    await client.changes(0, signal());
    assertEquals(made, 2);
    assertEquals(used.length, 2);
    assertNotStrictEquals(used[0], used[1]);
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient: a read is sent again at most once; the second unanswered try is unreachable", async () => {
  const { client, requests } = clientWith(neverAnswered, {
    responseBaseMs: 20,
    timeoutSignal: neverTimesOut,
  });
  try {
    await assertRejects(
      () => client.changes(0, signal()),
      ServeUnreachableError,
    );
    assertEquals(requests.length, 2);
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient: a commit serve never answers is not sent again", async () => {
  const { client, requests } = clientWith(neverAnswered, {
    responseBaseMs: 20,
    commitResponseBaseMs: 20,
    timeoutSignal: neverTimesOut,
  });
  try {
    await assertRejects(
      () =>
        client.postCommit(
          modelPartition(),
          { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
          [],
          signal(),
        ),
      ServeUnreachableError,
    );
    assertEquals(requests.length, 1);
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient.acquireLock: the response deadline waits out the wait the lock asks of serve", async () => {
  const { client } = clientWith(
    async () => {
      await new Promise((done) => setTimeout(done, 60));
      return Response.json({
        code: "lock_held",
        heldBy: "serve",
        message: "held by serve's own work",
      }, { status: 409 });
    },
    { responseBaseMs: 10, timeoutSignal: neverTimesOut },
  );
  try {
    const reply = await client.acquireLock("k", 30_000, 5_000, signal());
    assertEquals(reply.acquired, false);
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient: a request its caller timed out leaves its connection, so the next one opens a fresh one", async () => {
  let made = 0;
  const used: unknown[] = [];
  const client = new ServeDatastoreClient({
    baseUrl: BASE,
    httpClient: () => {
      made++;
      return Deno.createHttpClient({});
    },
    fetch: (input, init) => {
      used.push((init as { client?: unknown }).client);
      return used.length === 1
        ? neverAnswered(new Request(input, init))
        : Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  try {
    const caller = new AbortController();
    const pending = client.renewLock("lease", 30_000, caller.signal);
    caller.abort(new DOMException("renewal deadline", "TimeoutError"));
    await assertRejects(() => pending);
    await client.releaseLock("lease", signal());
    assertEquals(made, 2);
    assertNotStrictEquals(used[0], used[1]);
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient: on the process-wide pool, a timed-out request moves later ones to a connection of their own", async () => {
  const used: unknown[] = [];
  const client = new ServeDatastoreClient({
    baseUrl: BASE,
    responseBaseMs: 20,
    timeoutSignal: neverTimesOut,
    fetch: (input, init) => {
      used.push((init as { client?: unknown }).client);
      return used.length <= 2
        ? neverAnswered(new Request(input, init))
        : Promise.resolve(
          Response.json({ changes: [], cursor: 0, more: false }),
        );
    },
  });
  try {
    await assertRejects(
      () => client.changes(0, signal()),
      ServeUnreachableError,
    );
    await client.changes(0, signal());
    assertEquals(used[0], undefined);
    assertInstanceOf(used[2], Deno.HttpClient);
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient.acquireLock: a request that may have reached serve without a reply is cancelled by its id on a fresh connection", async () => {
  const { client, requests } = clientWith(
    (req) =>
      req.method === "POST"
        ? neverAnswered(req)
        : Response.json({ cancelled: true }),
    { responseBaseMs: 20, timeoutSignal: neverTimesOut },
  );
  try {
    await assertRejects(
      () => client.acquireLock(LOCK_KEY, 30_000, 0, signal()),
      ServeUnreachableError,
    );
    assertEquals(requests.length, 2);
    const asked = await requests[0].json();
    assertEquals(requests[1].method, "DELETE");
    assertEquals(
      requests[1].url,
      `${PREFIX}/locks/requests/${asked.requestId}`,
    );
  } finally {
    client.close();
  }
});

Deno.test("ServeDatastoreClient.acquireLock: a request never sent, or one serve answered, is not cancelled", async () => {
  const refused = clientWith(() =>
    Promise.reject(new TypeError("tcp connect error: Connection refused"))
  );
  await assertRejects(
    () => refused.client.acquireLock(LOCK_KEY, 30_000, 0, signal()),
    ServeUnreachableError,
  );
  assertEquals(refused.requests.length, 1);
  const answered = clientWith(() => Response.json(LEASE, { status: 201 }));
  await answered.client.acquireLock(LOCK_KEY, 30_000, 0, signal());
  assertEquals(answered.requests.length, 1);
});

Deno.test("ServeDatastoreClient: a connection retired after a timeout is closed once its request settles, not left open until the client closes", async () => {
  let closed = 0;
  const reads = new ServeDatastoreClient({
    baseUrl: BASE,
    responseBaseMs: 20,
    timeoutSignal: neverTimesOut,
    httpClient: () => {
      const made = Deno.createHttpClient({});
      const close = made.close.bind(made);
      made.close = () => {
        closed++;
        close();
      };
      return made;
    },
    fetch: (input, init) => neverAnswered(new Request(input, init)),
  });
  try {
    await assertRejects(() => reads.changes(0, signal()));
    assertEquals(closed, 2, "both retired connections closed as they settled");
  } finally {
    reads.close();
  }
  assertEquals(closed, 2, "nothing left for close() to end");
});

const LOG = "log-a";

function refusalClock(): {
  now: () => number;
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
  waits: number[];
} {
  let at = 0;
  const waits: number[] = [];
  return {
    now: () => at,
    delay: (ms, signal) => {
      signal.throwIfAborted();
      waits.push(ms);
      at += ms;
      return Promise.resolve();
    },
    waits,
  };
}

function notLeader(
  options: {
    readonly address?: string;
    readonly inFlight?: boolean;
    readonly reads?: boolean;
    readonly log?: string;
  } = {},
): Response {
  return Response.json({
    code: SERVE_NOT_LEADER_CODE,
    message: "not the leader",
    ...(options.address !== undefined
      ? {
        leader: {
          instanceId: "leader-1",
          fence: 3,
          address: options.address,
          since: "2026-11-10T00:00:00.000Z",
        },
      }
      : {}),
    ...(options.inFlight === true ? { inFlight: true } : {}),
    ...(options.reads === true ? { reads: true } : {}),
  }, {
    status: 503,
    headers: {
      "Retry-After": "5",
      [SERVE_DATASTORE_LOG_HEADER]: options.log ?? LOG,
    },
  });
}

function chunkReply(bytes: Uint8Array, log = LOG): Response {
  return new Response(bytes.slice(), {
    headers: { [SERVE_DATASTORE_LOG_HEADER]: log },
  });
}

async function withRefusalState(fn: () => Promise<void>): Promise<void> {
  clearServeUnreachableLatches();
  try {
    await fn();
  } finally {
    clearServeUnreachableLatches();
  }
}

const CHUNK = new TextEncoder().encode("chunk bytes");

Deno.test("ServeDatastoreClient: a read refused as not the leader is retried with backoff until serve answers", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client, requests } = clientWith(
      (_req, call) => call <= 3 ? notLeader() : chunkReply(CHUNK),
      clock,
    );
    assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
    assertEquals(requests.length, 4);
    assertEquals(clock.waits, [250, 500, 1_000]);
  });
});

Deno.test("ServeDatastoreClient: feed, change and chunk-check reads ride out a follower behind the copy", async () => {
  await withRefusalState(async () => {
    const behind = () =>
      Response.json(
        { code: SERVE_FOLLOWER_BEHIND_CODE, message: "behind" },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    const clock = refusalClock();
    const { client, requests } = clientWith((req, call) => {
      if (call % 2 === 1) return behind();
      return new URL(req.url).pathname.endsWith("/chunks/has")
        ? Response.json({ held: [] })
        : Response.json({ changes: [], cursor: 0, more: false });
    }, clock);
    await client.hasChunks(["a".repeat(64)], signal());
    await client.changes(0, signal());
    assertEquals(requests.length, 4);
  });
});

Deno.test("ServeDatastoreClient: a read refused past the budget throws serve's refusal, a stale copy's saying so", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client, requests } = clientWith(() => notLeader({ reads: true }), {
      ...clock,
      readRefusalBudgetMs: 3_000,
    });
    const error = await assertRejects(
      () => client.getChunk(sha(CHUNK), signal()),
      ServeNotLeaderError,
    );
    assertEquals(error.reads, true);
    assertStringIncludes(error.message, "did not answer");
    assertEquals(clock.waits.reduce((sum, ms) => sum + ms, 0), 3_000);
    assert(requests.length > 2);
  });
});

Deno.test("ServeDatastoreClient: the refusal budget is shared by every client of one serve, and a command's end resets it", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const options = { ...clock, readRefusalBudgetMs: 1_000 };
    const first = clientWith(() => notLeader(), options);
    await assertRejects(
      () => first.client.getChunk(sha(CHUNK), signal()),
      ServeNotLeaderError,
    );
    const second = clientWith(() => notLeader(), options);
    await assertRejects(
      () => second.client.getChunk(sha(CHUNK), signal()),
      ServeNotLeaderError,
    );
    assertEquals(second.requests.length, 1, "no budget was left to wait");
    clearServeUnreachableLatches();
    const third = clientWith(
      (_req, call) => call === 1 ? notLeader() : chunkReply(CHUNK),
      options,
    );
    assertEquals(await third.client.getChunk(sha(CHUNK), signal()), CHUNK);
  });
});

Deno.test("ServeDatastoreClient: a reply that is not a refusal ends the streak, so a later refusal gets the whole budget", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client } = clientWith(
      (_req, call) => [1, 3].includes(call) ? notLeader() : chunkReply(CHUNK),
      { ...clock, readRefusalBudgetMs: 250 },
    );
    assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
    assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
    assertEquals(clock.waits, [250, 250]);
  });
});

Deno.test("ServeDatastoreClient: commits, chunk uploads and lease calls refused as not the leader are sent once", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client, requests } = clientWith(
      () => notLeader({ address: "https://serve.example.com:9443" }),
      clock,
    );
    await assertRejects(() =>
      client.postCommit(
        modelPartition(),
        { expectedSeq: 0, txnId: crypto.randomUUID(), ops: [] },
        [],
        signal(),
      )
    );
    await assertRejects(() =>
      client.putChunk(sha(CHUNK), CHUNK, signal(), modelPartition())
    );
    await assertRejects(() => client.releaseLock("lease", signal()));
    assertEquals(requests.length, 3);
    assertEquals(clock.waits, []);
  });
});

Deno.test("ServeDatastoreClient: a read refused in flight is not retried", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client, requests } = clientWith(
      () => notLeader({ inFlight: true }),
      clock,
    );
    const error = await assertRejects(
      () => client.getChunk(sha(CHUNK), signal()),
      ServeNotLeaderError,
    );
    assertEquals(error.inFlight, true);
    assertEquals(requests.length, 1);
  });
});

Deno.test("ServeDatastoreClient: a read opted out of the retry throws the refusal at once", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client, requests } = clientWith(() => notLeader(), clock);
    await assertRejects(
      () => client.listLocks("", signal(), { retryRefusals: false }),
      ServeNotLeaderError,
    );
    assertEquals(requests.length, 1);
    assertEquals(clock.waits, []);
  });
});

Deno.test("ServeDatastoreClient: stopping a command ends a refused read's wait at once", async () => {
  await withRefusalState(async () => {
    const stop = new AbortController();
    const reason = new Error("command stopped");
    const { client, requests } = clientWith(() => notLeader(), {
      delay: (_ms, waitSignal) => {
        stop.abort(reason);
        return Promise.reject(waitSignal.reason);
      },
    });
    const error = await assertRejects(() =>
      client.getChunk(sha(CHUNK), stop.signal)
    );
    assertStrictEquals(error, reason);
    assertEquals(requests.length, 1);
  });
});

Deno.test("ServeDatastoreClient: a refused read follows a leader on the configured host that names the same log", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client, requests } = clientWith(
      (req) =>
        new URL(req.url).origin === BASE
          ? notLeader({ address: "https://serve.example.com:9443" })
          : chunkReply(CHUNK),
      clock,
    );
    assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
    assertEquals(requests.map((req) => new URL(req.url).origin), [
      BASE,
      "https://serve.example.com:9443",
    ]);
    assertEquals(
      requests[1].headers.get("authorization"),
      "Bearer tok",
    );
  });
});

Deno.test("ServeDatastoreClient: a leader on another host, or in cleartext off loopback, is never followed", async () => {
  for (
    const address of [
      "https://elsewhere.example.com",
      "http://serve.example.com:9090",
      "ftp://serve.example.com",
      "not a url",
    ]
  ) {
    await withRefusalState(async () => {
      const clock = refusalClock();
      const { client, requests } = clientWith(
        (_req, call) => call === 1 ? notLeader({ address }) : chunkReply(CHUNK),
        clock,
      );
      assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
      assertEquals(
        requests.map((req) => new URL(req.url).origin),
        [BASE, BASE],
        address,
      );
    });
  }
});

Deno.test("ServeDatastoreClient: a loopback serve's leader on another loopback port is followed over http", async () => {
  await withRefusalState(async () => {
    const base = "http://127.0.0.1:9090";
    const leader = "http://127.0.0.1:9091";
    const clock = refusalClock();
    const { client, requests } = clientWith(
      (req) =>
        new URL(req.url).origin === base
          ? notLeader({ address: leader })
          : chunkReply(CHUNK),
      { ...clock, baseUrl: base },
    );
    assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
    assertEquals(requests.map((req) => new URL(req.url).origin), [
      base,
      leader,
    ]);
  });
});

Deno.test("ServeDatastoreClient: a followed leader that does not answer, names another log or fails is left for the configured serve", async () => {
  const leader = "https://serve.example.com:9443";
  const answers: Record<string, () => Response | Promise<Response>> = {
    "does not connect": () =>
      Promise.reject(new TypeError("error sending request for url")),
    "names another log": () => chunkReply(CHUNK, "log-b"),
    "fails": () =>
      Response.json({ code: "internal", message: "boom" }, {
        status: 500,
        headers: { [SERVE_DATASTORE_LOG_HEADER]: LOG },
      }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    await withRefusalState(async () => {
      const clock = refusalClock();
      let checked = 0;
      const { client, requests } = clientWith(
        (req, call) =>
          new URL(req.url).origin !== BASE
            ? answer()
            : call === 1
            ? notLeader({ address: leader })
            : chunkReply(CHUNK),
        clock,
      );
      client.checkLog((logId) => {
        checked++;
        assertEquals(logId, LOG);
      });
      assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK, name);
      assertEquals(
        requests.map((req) => new URL(req.url).origin),
        [BASE, leader, BASE],
        name,
      );
      assertEquals(checked, 2, `${name}: only the configured serve's replies`);
    });
  }
});

Deno.test("ServeDatastoreClient: a read refused throughout ends within its own budget even while other requests keep resetting the shared streak", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const other = clientWith(() => Response.json({ held: [] }), clock);
    const { client } = clientWith(() => notLeader(), {
      ...clock,
      readRefusalBudgetMs: 2_000,
      delay: async (ms, waitSignal) => {
        await clock.delay(ms, waitSignal);
        await other.client.hasChunks(["a".repeat(64)], waitSignal);
      },
    });
    await assertRejects(
      () => client.getChunk(sha(CHUNK), signal()),
      ServeNotLeaderError,
    );
    assertEquals(clock.waits.reduce((sum, ms) => sum + ms, 0), 2_000);
  });
});

Deno.test("ServeDatastoreClient: refusal retries leave a later 429 its own retries", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client, requests } = clientWith(
      (_req, call) =>
        call <= 3
          ? notLeader()
          : call === 4
          ? Response.json({ code: "rate_limited", message: "slow down" }, {
            status: 429,
            headers: { "Retry-After": "1" },
          })
          : chunkReply(CHUNK),
      { ...clock, maxRetryDelayMs: 1 },
    );
    assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
    assertEquals(requests.length, 5);
  });
});

Deno.test("ServeDatastoreClient: a refusal asking to retry at once still waits before the next try", async () => {
  await withRefusalState(async () => {
    const clock = refusalClock();
    const { client } = clientWith(
      (_req, call) =>
        call === 1
          ? Response.json({ code: SERVE_NOT_LEADER_CODE, message: "no" }, {
            status: 503,
            headers: { "Retry-After": "0" },
          })
          : chunkReply(CHUNK),
      clock,
    );
    assertEquals(await client.getChunk(sha(CHUNK), signal()), CHUNK);
    assertEquals(clock.waits, [250]);
  });
});

Deno.test("ServeDatastoreClient: a refused read whose body is cut off is unreachable, as a cut reply always was", async () => {
  await withRefusalState(async () => {
    const { client } = clientWith(() =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"code":'));
            controller.error(
              new TypeError("error reading a body from connection"),
            );
          },
        }),
        { status: 503 },
      )
    );
    const error = await assertRejects(
      () => client.getChunk(sha(CHUNK), signal()),
      ServeUnreachableError,
    );
    assertEquals(error.sent, "maybe");
  });
});
