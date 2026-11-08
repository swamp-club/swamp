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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import {
  createInMemoryRemote,
  InMemoryRateLimitError,
} from "../../../packages/testing/in_memory_remote.ts";
import type { WritableDatastoreControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  BUCKET_WRITE_RETRY_BUDGET_MS,
  bucketWriteRefusal,
  type BucketWriteRetryDeps,
  retryingControlPlane,
  retryingStorage,
  withBucketWriteDeadline,
} from "./bucket_write_retry.ts";

function fakeClock() {
  const clock = { now: 0, sleeps: [] as number[] };
  const deps: Partial<BucketWriteRetryDeps> = {
    now: () => clock.now,
    random: () => 0.5,
    sleep: (ms) => {
      clock.sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
  };
  return { clock, deps };
}

async function withLogs(
  fn: (messages: () => [string, string][]) => Promise<void>,
): Promise<void> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      {
        category: ["datastore", "v3", "bucket"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn(() =>
      captured.map((r) => [r.level, r.message.map((p) => String(p)).join("")])
    );
  } finally {
    await reset();
  }
}

/** refuses the first `times` calls of each write with `error` */
function flaky(
  store: WritableDatastoreControlPlaneStore,
  times: number,
  error: () => Error,
  options: { readonly landFirst?: boolean } = {},
): WritableDatastoreControlPlaneStore & { calls: number } {
  const wrapped = {
    calls: 0,
    get: store.get.bind(store),
    list: store.list.bind(store),
    async put(key: string, data: Uint8Array) {
      if (wrapped.calls++ < times) throw error();
      await store.put(key, data);
    },
    async delete(key: string) {
      if (wrapped.calls++ < times) throw error();
      await store.delete(key);
    },
    async putIfAbsent(key: string, data: Uint8Array) {
      if (wrapped.calls++ < times) {
        // The create lands, but its answer is lost.
        if (options.landFirst === true && wrapped.calls === 1) {
          await store.putIfAbsent(key, data);
        }
        throw error();
      }
      return await store.putIfAbsent(key, data);
    },
  };
  return wrapped;
}

function memoryStore(): WritableDatastoreControlPlaneStore {
  return createInMemoryRemote({ controlPlane: true })
    .datastoreControlPlaneStore!();
}

const http503 = () =>
  Object.assign(new Error("GCS putObject failed HTTP 503 backendError"), {
    httpStatusCode: 503,
    code: "backendError",
  });
const encode = (text: string) => new TextEncoder().encode(text);

Deno.test("bucketWriteRefusal: reads the status from the provider error or its cause", () => {
  assertEquals(
    bucketWriteRefusal(new InMemoryRateLimitError("gcs", "k")),
    "rate_limited",
  );
  assertEquals(
    bucketWriteRefusal(new InMemoryRateLimitError("s3", "k")),
    "rate_limited",
  );
  assertEquals(bucketWriteRefusal(http503()), "unavailable");
  assertEquals(
    bucketWriteRefusal(
      new Error("published failed", {
        cause: new InMemoryRateLimitError("gcs", "k"),
      }),
    ),
    "rate_limited",
  );
  assertEquals(
    bucketWriteRefusal({ $metadata: { httpStatusCode: 429 } }),
    "rate_limited",
  );
  assertEquals(
    bucketWriteRefusal(new Error("S3 putObject failed HTTP 403 AccessDenied")),
    undefined,
  );
  assertEquals(bucketWriteRefusal(new Error("socket hang up")), undefined);
});

Deno.test("retryingControlPlane: a 429 then success writes the record and logs the retry at info", async () => {
  await withLogs(async (messages) => {
    const { clock, deps } = fakeClock();
    const inner = memoryStore();
    const store = retryingControlPlane(
      flaky(inner, 1, () => new InMemoryRateLimitError("gcs", "head")),
      deps,
    );
    await store.put("lineage/head.json", encode("a"));
    assertEquals(await inner.get("lineage/head.json"), encode("a"));
    assertEquals(clock.sleeps.length, 1);
    const logged = messages();
    assertEquals(logged.map(([level]) => level), ["info", "info"]);
    assertStringIncludes(logged[0][1], "bucket_write_rate_limited");
    assertStringIncludes(logged[0][1], "lineage/head.json");
    assertStringIncludes(logged[0][1], "attempt 1");
    assertStringIncludes(logged[1][1], "succeeded on attempt 2");
  });
});

Deno.test("retryingControlPlane: a 429 that outlasts the budget rethrows the provider's error and logs a warning", async () => {
  await withLogs(async (messages) => {
    const { clock, deps } = fakeClock();
    const refusal = new InMemoryRateLimitError("gcs", "head");
    const store = retryingControlPlane(
      flaky(memoryStore(), Infinity, () => refusal),
      deps,
    );
    const thrown = await assertRejects(() => store.put("k", encode("a")));
    assertEquals(thrown, refusal);
    assertEquals(clock.now <= BUCKET_WRITE_RETRY_BUDGET_MS, true);
    const logged = messages();
    assertEquals(logged.at(-1)?.[0], "warning");
    assertStringIncludes(logged.at(-1)![1], "bucket_write_rate_limited");
    assertStringIncludes(logged.at(-1)![1], `after ${clock.sleeps.length + 1}`);
  });
});

Deno.test("retryingControlPlane: an enclosing deadline cuts the retries short", async () => {
  const { clock, deps } = fakeClock();
  const store = retryingControlPlane(
    flaky(
      memoryStore(),
      Infinity,
      () => new InMemoryRateLimitError("gcs", "k"),
    ),
    deps,
  );
  await withBucketWriteDeadline(300, async () => {
    await assertRejects(() => store.put("k", encode("a")));
  });
  assertEquals(clock.now <= 300, true);
});

Deno.test("retryingControlPlane: an error that is not a rate limit or 503 is not retried", async () => {
  const { clock, deps } = fakeClock();
  const denied = new Error("GCS putObject failed HTTP 403 forbidden");
  const inner = flaky(memoryStore(), 1, () => denied);
  const store = retryingControlPlane(inner, deps);
  assertEquals(await assertRejects(() => store.put("k", encode("a"))), denied);
  assertEquals(inner.calls, 1);
  assertEquals(clock.sleeps, []);
});

Deno.test("retryingControlPlane: a putIfAbsent whose 503'd create landed answers true", async () => {
  const { deps } = fakeClock();
  const inner = memoryStore();
  const store = retryingControlPlane(
    flaky(inner, 1, http503, { landFirst: true }),
    deps,
  );
  assertEquals(await store.putIfAbsent("writer/fence-1", encode("mine")), true);
});

Deno.test("retryingControlPlane: a putIfAbsent after a 503 still loses to another writer's record", async () => {
  const { deps } = fakeClock();
  const inner = memoryStore();
  await inner.putIfAbsent("writer/fence-1", encode("theirs"));
  const store = retryingControlPlane(flaky(inner, 1, http503), deps);
  assertEquals(
    await store.putIfAbsent("writer/fence-1", encode("mine")),
    false,
  );
  assertEquals(await inner.get("writer/fence-1"), encode("theirs"));
});

Deno.test("retryingControlPlane: a putIfAbsent refused by a 429 re-sends and creates", async () => {
  const { deps } = fakeClock();
  const inner = memoryStore();
  const store = retryingControlPlane(
    flaky(inner, 2, () => new InMemoryRateLimitError("gcs", "k")),
    deps,
  );
  assertEquals(await store.putIfAbsent("k", encode("a")), true);
  assertEquals(await store.putIfAbsent("k", encode("a")), false);
});

Deno.test("retryingControlPlane: a putIfAbsent whose 503s outlast the budget answers true when its create landed", async () => {
  const { deps } = fakeClock();
  const inner = memoryStore();
  const store = retryingControlPlane(
    flaky(inner, Infinity, http503, { landFirst: true }),
    deps,
  );
  assertEquals(await store.putIfAbsent("k", encode("a")), true);
});

Deno.test("retryingControlPlane: reads and listings pass through unretried", async () => {
  const { clock, deps } = fakeClock();
  let gets = 0;
  const inner = memoryStore();
  const store = retryingControlPlane({
    ...inner,
    get: () => {
      gets++;
      return Promise.reject(new InMemoryRateLimitError("gcs", "k"));
    },
    list: inner.list.bind(inner),
    put: inner.put.bind(inner),
    putIfAbsent: inner.putIfAbsent.bind(inner),
    delete: inner.delete.bind(inner),
  }, deps);
  await assertRejects(() => store.get("k"));
  assertEquals(gets, 1);
  assertEquals(clock.sleeps, []);
});

Deno.test("retryingStorage: a chunk put and touch retry a 429, and other methods reach the provider", async () => {
  const { deps } = fakeClock();
  let now = 0;
  const remote = createInMemoryRemote({
    storage: true,
    mutationRateLimit: { intervalMs: 1_000, now: () => now },
  });
  const sleeping: Partial<BucketWriteRetryDeps> = {
    ...deps,
    sleep: (ms) => {
      now += ms;
      return deps.sleep!(ms);
    },
  };
  class Extended {
    constructor(readonly inner = remote.storage!()) {}
    get contract() {
      return this.inner.contract;
    }
    capabilities() {
      return this.inner.capabilities();
    }
    has(ns: string, h: readonly string[], s: AbortSignal) {
      return this.inner.has(ns, h, s);
    }
    put(ns: string, sha: string, b: Uint8Array, s: AbortSignal) {
      return this.inner.put(ns, sha, b, s);
    }
    get(ns: string, sha: string, s: AbortSignal) {
      return this.inner.get(ns, sha, s);
    }
    touch(ns: string, h: readonly string[], s: AbortSignal) {
      return this.inner.touch!(ns, h, s);
    }
    list(ns: string, s: AbortSignal) {
      return this.inner.list(ns, s);
    }
    delete(ns: string, sha: string, s: AbortSignal) {
      return this.inner.delete(ns, sha, s);
    }
    statChunks() {
      return Promise.resolve(new Map());
    }
  }
  const storage = retryingStorage(new Extended(), sleeping);
  const signal = new AbortController().signal;
  const sha = "ab".padEnd(64, "0");
  await storage.put("ns", sha, new Uint8Array([1]), signal);
  await storage.put("ns", sha, new Uint8Array([1]), signal);
  assertEquals((await storage.touch!("ns", [sha], signal)).size, 0);
  const mutations = remote.mutations();
  // the second put and the touch were each refused before landing
  assertEquals(mutations.filter((m) => !m.refused).length, 3);
  assertEquals(mutations.filter((m) => m.refused).length > 1, true);
  assertEquals(storage.contract, "storage/1");
  assertEquals(
    typeof (storage as unknown as { statChunks?: unknown }).statChunks,
    "function",
  );
});
