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

import { assertEquals } from "@std/assert";
import { HEALTH_RETRY_MS } from "./health_state.ts";
import { type HealthSnapshot, readHealthStream } from "./useHealthStream.ts";

function frame(instanceId: string): string {
  return `event: health\ndata: ${JSON.stringify({ instanceId })}\n\n`;
}

/** A fetch answering one stream whose chunks the test pushes itself. */
function streamingFetch(status = 200, headers: HeadersInit = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  const fetchFn = (_url: string | URL | Request, init?: RequestInit) => {
    // Like a real fetch: an aborted signal rejects at once, and aborting
    // later errors the body being read.
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    init?.signal?.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        // already closed
      }
    });
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return {
    fetchFn: fetchFn as typeof fetch,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

function reader(
  fetchFn: typeof fetch,
  signal: AbortSignal,
  snapshots: string[],
  opened: { count: number } = { count: 0 },
) {
  return readHealthStream({
    url: "http://serve/api/v1/health/stream?interval=5000",
    headers: {},
    signal,
    onOpen: () => opened.count++,
    onSnapshot: (s: HealthSnapshot) => snapshots.push(s.instanceId),
    fetchFn,
  });
}

Deno.test("readHealthStream: hands each health event to onSnapshot", async () => {
  const stream = streamingFetch();
  const snapshots: string[] = [];
  const opened = { count: 0 };
  const done = reader(
    stream.fetchFn,
    new AbortController().signal,
    snapshots,
    opened,
  );
  stream.push(frame("a"));
  // A frame split across chunks still parses.
  stream.push("event: health\ndata: ");
  stream.push(`${JSON.stringify({ instanceId: "b" })}\n\n`);
  stream.push(`event: session-ended\ndata: {"code":4001}\n\n`);
  stream.close();
  assertEquals(await done, { kind: "retry", retryMs: HEALTH_RETRY_MS });
  assertEquals(snapshots, ["a", "b"]);
  assertEquals(opened.count, 1);
});

Deno.test("readHealthStream: aborting closes the stream and delivers nothing more", async () => {
  const stream = streamingFetch();
  const snapshots: string[] = [];
  const abort = new AbortController();
  const done = readHealthStream({
    url: "http://serve/api/v1/health/stream?interval=5000",
    headers: {},
    signal: abort.signal,
    onOpen: () => {},
    // The tab hides right after the first snapshot lands.
    onSnapshot: (s: HealthSnapshot) => {
      snapshots.push(s.instanceId);
      abort.abort();
    },
    fetchFn: stream.fetchFn,
  });
  // Both frames arrive in one chunk; the second is read after the abort.
  stream.push(frame("a") + frame("b"));
  await done;
  assertEquals(snapshots, ["a"]);
});

Deno.test("readHealthStream: a stream closed before it opens delivers nothing", async () => {
  const stream = streamingFetch();
  const snapshots: string[] = [];
  const opened = { count: 0 };
  const abort = new AbortController();
  // A snapshot is already waiting when the tab hides.
  stream.push(frame("a"));
  abort.abort();
  await reader(stream.fetchFn, abort.signal, snapshots, opened);
  assertEquals(snapshots, []);
  assertEquals(opened.count, 0);
});

Deno.test("readHealthStream: a refused token is denied, not retried", async () => {
  for (const status of [401, 403]) {
    const stream = streamingFetch(status);
    const opened = { count: 0 };
    const end = await reader(
      stream.fetchFn,
      new AbortController().signal,
      [],
      opened,
    );
    assertEquals(end, { kind: "denied" });
    assertEquals(opened.count, 0);
  }
});

Deno.test("readHealthStream: the stream cap waits as long as Retry-After asks", async () => {
  const stream = streamingFetch(429, { "Retry-After": "30" });
  const end = await reader(stream.fetchFn, new AbortController().signal, []);
  assertEquals(end, { kind: "retry", retryMs: 30_000 });
});

Deno.test("readHealthStream: a failed fetch retries after the default delay", async () => {
  const failing =
    (() => Promise.reject(new TypeError("offline"))) as typeof fetch;
  const end = await reader(failing, new AbortController().signal, []);
  assertEquals(end, { kind: "retry", retryMs: HEALTH_RETRY_MS });
});
