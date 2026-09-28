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

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { HealthSnapshot } from "./health_collector.ts";
import {
  createHealthStreamResponse,
  DEFAULT_HEALTH_STREAM_INTERVAL_MS,
  HEALTH_STREAM_CAP_RETRY_AFTER_SECONDS,
  type HealthStreamCloser,
  healthStreamInterval,
  type HealthStreamOptions,
} from "./health_stream.ts";

const SNAPSHOT = { instanceId: "instance-1" } as HealthSnapshot;

interface Harness {
  options: HealthStreamOptions;
  server: AbortController;
  client: AbortController;
  collects: number;
  unregisters: number;
  closer: HealthStreamCloser | null;
}

function harness(
  overrides: Partial<HealthStreamOptions> = {},
  register: "none" | "allow" | "refuse" = "allow",
): Harness {
  const server = new AbortController();
  const client = new AbortController();
  const h: Harness = {
    server,
    client,
    collects: 0,
    unregisters: 0,
    closer: null,
    options: {
      collect: () => {
        h.collects++;
        return Promise.resolve(SNAPSHOT);
      },
      intervalParam: null,
      lastEventId: null,
      serverSignal: server.signal,
      requestSignal: client.signal,
      registerSession: register === "none" ? undefined : (closer) => {
        h.closer = closer;
        return register === "refuse" ? null : () => {
          h.unregisters++;
        };
      },
      ...overrides,
    },
  };
  return h;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  text: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  return seen;
}

Deno.test("healthStreamInterval: defaults, ignores junk and clamps to 1-60 s", () => {
  assertEquals(healthStreamInterval(null), DEFAULT_HEALTH_STREAM_INTERVAL_MS);
  assertEquals(healthStreamInterval("soon"), DEFAULT_HEALTH_STREAM_INTERVAL_MS);
  assertEquals(healthStreamInterval("10"), 1000);
  assertEquals(healthStreamInterval("2500"), 2500);
  assertEquals(healthStreamInterval("999999"), 60000);
});

Deno.test("createHealthStreamResponse: streams a health event resuming from Last-Event-ID", async () => {
  const h = harness({ intervalParam: "2000", lastEventId: "7" });
  const response = createHealthStreamResponse(h.options);

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/event-stream");
  assertEquals(response.headers.get("x-health-interval"), "2000");
  const reader = response.body!.getReader();
  const seen = await readUntil(reader, "\n\n");
  assertEquals(
    seen,
    `id: 8\nevent: health\ndata: ${JSON.stringify(SNAPSHOT)}\n\n`,
  );

  h.client.abort();
  await reader.cancel();
});

Deno.test("createHealthStreamResponse: at the stream cap answers 429 and collects nothing", () => {
  const h = harness({}, "refuse");
  const response = createHealthStreamResponse(h.options);

  assertEquals(response.status, 429);
  assertEquals(
    response.headers.get("retry-after"),
    String(HEALTH_STREAM_CAP_RETRY_AFTER_SECONDS),
  );
  assertEquals(h.collects, 0);
});

Deno.test("createHealthStreamResponse: without a session binding it streams unregistered", async () => {
  const h = harness({}, "none");
  const response = createHealthStreamResponse(h.options);
  const reader = response.body!.getReader();
  await readUntil(reader, "event: health");

  assertEquals(h.closer, null);
  h.client.abort();
  await reader.cancel();
});

for (
  const [label, end] of [
    ["the client disconnects", (h: Harness) => h.client.abort()],
    ["serve shuts down", (h: Harness) => h.server.abort()],
  ] as const
) {
  Deno.test(`createHealthStreamResponse: unregisters once when ${label}`, async () => {
    const h = harness();
    const response = createHealthStreamResponse(h.options);
    const reader = response.body!.getReader();
    await readUntil(reader, "event: health");

    end(h);
    h.client.abort();
    h.server.abort();

    assertEquals(h.unregisters, 1);
    const { done } = await reader.read();
    assertEquals(done, true);
  });
}

Deno.test("createHealthStreamResponse: unregisters when the body is cancelled", async () => {
  const h = harness();
  const response = createHealthStreamResponse(h.options);
  const reader = response.body!.getReader();
  await readUntil(reader, "event: health");

  await reader.cancel();

  assertEquals(h.unregisters, 1);
});

Deno.test("createHealthStreamResponse: ending the session sends session-ended, then closes", async () => {
  const h = harness();
  const response = createHealthStreamResponse(h.options);
  const reader = response.body!.getReader();
  await readUntil(reader, "event: health");

  h.closer!.close(4003, "Session revoked: token revoked");
  h.closer!.close(4003, "Session revoked: token revoked");

  const rest = await readUntil(reader, "never-sent");
  assertEquals(
    rest,
    `event: session-ended\ndata: ${
      JSON.stringify({ code: 4003, reason: "Session revoked: token revoked" })
    }\n\n`,
  );
  assertEquals(h.unregisters, 1);
});

Deno.test("createHealthStreamResponse: a request already aborted never collects", async () => {
  const h = harness();
  h.client.abort();
  const response = createHealthStreamResponse(h.options);
  const reader = response.body!.getReader();

  const { done } = await reader.read();
  assertEquals(done, true);
  assertEquals(h.collects, 0);
  assertEquals(h.unregisters, 1);
});

Deno.test("createHealthStreamResponse: a failed collection skips the tick without ending the stream", async () => {
  let calls = 0;
  const h = harness({
    intervalParam: "1000",
    collect: () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("datastore down"))
        : Promise.resolve(SNAPSHOT);
    },
  });
  const response = createHealthStreamResponse(h.options);
  const reader = response.body!.getReader();

  const seen = await readUntil(reader, "event: health");
  assertStringIncludes(seen, "id: 1\n");
  assertEquals(calls, 2);

  h.client.abort();
  await reader.cancel();
});
