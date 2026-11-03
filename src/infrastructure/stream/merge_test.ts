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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { merge, mergeGated, mergeWithConcurrency } from "./merge.ts";

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

async function* delayed<T>(items: T[], ms: number): AsyncGenerator<T> {
  for (const item of items) {
    await new Promise((r) => setTimeout(r, ms));
    yield item;
  }
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of stream) {
    result.push(item);
  }
  return result;
}

Deno.test("merge empty array yields nothing", async () => {
  const items = await collect(merge([]));
  assertEquals(items, []);
});

Deno.test("merge single stream is passthrough", async () => {
  const items = await collect(merge([fromArray([1, 2, 3])]));
  assertEquals(items, [1, 2, 3]);
});

Deno.test("merge two streams contains all items", async () => {
  const items = await collect(merge([
    fromArray(["a", "b"]),
    fromArray(["c", "d"]),
  ]));
  assertEquals(items.sort(), ["a", "b", "c", "d"]);
});

Deno.test("merge interleaves delayed streams", async () => {
  const items = await collect(merge([
    delayed(["a1", "a2"], 5),
    delayed(["b1", "b2"], 5),
  ]));
  assertEquals(items.length, 4);
  assertEquals(items.sort(), ["a1", "a2", "b1", "b2"]);
});

Deno.test("merge handles streams of different lengths", async () => {
  const items = await collect(merge([
    fromArray([1]),
    fromArray([2, 3, 4]),
    fromArray([5, 6]),
  ]));
  assertEquals(items.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

Deno.test("merge handles stream that yields nothing", async () => {
  const items = await collect(merge([
    fromArray([]),
    fromArray([1, 2]),
  ]));
  assertEquals(items, [1, 2]);
});

Deno.test("merge with pre-aborted signal yields nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const items = await collect(merge([
    fromArray([1, 2]),
    fromArray([3, 4]),
  ], controller.signal));
  assertEquals(items, []);
});

Deno.test("mergeWithConcurrency: undefined limit delegates to merge", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray([1, 2]),
    fromArray([3, 4]),
  ], undefined));
  assertEquals(items.sort((a, b) => a - b), [1, 2, 3, 4]);
});

Deno.test("mergeWithConcurrency: zero limit delegates to merge", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray(["a", "b"]),
    fromArray(["c"]),
  ], 0));
  assertEquals(items.sort(), ["a", "b", "c"]);
});

Deno.test("mergeWithConcurrency: limit >= streams delegates to merge", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray([1]),
    fromArray([2]),
  ], 5));
  assertEquals(items.sort((a, b) => a - b), [1, 2]);
});

Deno.test("mergeWithConcurrency: collects all items", async () => {
  const items = await collect(mergeWithConcurrency([
    fromArray([1, 2]),
    fromArray([3, 4]),
    fromArray([5, 6]),
    fromArray([7, 8]),
  ], 2));
  assertEquals(items.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

Deno.test("mergeWithConcurrency: limits actual concurrency", async () => {
  let active = 0;
  let maxActive = 0;

  async function* tracked(id: number): AsyncGenerator<number> {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    yield id;
    active--;
  }

  const streams = Array.from({ length: 6 }, (_, i) => tracked(i));
  const items = await collect(mergeWithConcurrency(streams, 2));
  assertEquals(items.length, 6);
  assertEquals(maxActive, 2);
});

Deno.test("mergeWithConcurrency: with pre-aborted signal yields nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const items = await collect(mergeWithConcurrency(
    [
      fromArray([1, 2]),
      fromArray([3, 4]),
    ],
    1,
    controller.signal,
  ));
  assertEquals(items, []);
});

async function* throwAfter<T>(
  items: T[],
  error: Error,
): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
  throw error;
}

function throwImmediately<T>(error: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return Promise.reject(error);
        },
      };
    },
  };
}

Deno.test("merge propagates source stream error", async () => {
  const err = new Error("generator crashed");
  await assertRejects(
    () => collect(merge([throwAfter([1, 2], err)])),
    Error,
    "generator crashed",
  );
});

Deno.test("merge propagates error from one of multiple streams", async () => {
  const err = new Error("stream B crashed");
  await assertRejects(
    () =>
      collect(merge([
        fromArray([1, 2]),
        throwImmediately(err),
      ])),
    Error,
    "stream B crashed",
  );
});

Deno.test("merge does not propagate stream error when signal is aborted", async () => {
  const controller = new AbortController();
  function abortThenThrow(): AsyncIterable<number> {
    return {
      [Symbol.asyncIterator]() {
        let called = false;
        return {
          async next() {
            if (!called) {
              called = true;
              controller.abort();
              await new Promise((r) => setTimeout(r, 10));
              throw new Error("should be suppressed");
            }
            return { value: undefined as unknown as number, done: true };
          },
        };
      },
    };
  }
  const items = await collect(merge(
    [fromArray([1]), abortThenThrow()],
    controller.signal,
  ));
  assertEquals(items.length <= 1, true);
});

Deno.test("mergeWithConcurrency propagates source stream error", async () => {
  const err = new Error("generator crashed");
  await assertRejects(
    () => collect(mergeWithConcurrency([throwAfter([1, 2], err)], 1)),
    Error,
    "generator crashed",
  );
});

Deno.test("mergeWithConcurrency propagates error from one of multiple streams", async () => {
  const err = new Error("step exploded");
  await assertRejects(
    () =>
      collect(mergeWithConcurrency([
        delayed([1, 2], 5),
        throwImmediately(err),
        fromArray([3, 4]),
      ], 2)),
    Error,
    "step exploded",
  );
});

async function* slowStream(
  durationMs: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  await new Promise<void>((resolve) => {
    const id = setTimeout(resolve, durationMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    }, { once: true });
  });
  yield "slow-done";
}

Deno.test("merge exits promptly when signal aborts during slow stream", async () => {
  const controller = new AbortController();
  const slowMs = 5_000;

  setTimeout(() => controller.abort(), 50);

  const start = performance.now();
  const items = await collect(merge(
    [fromArray(["fast"]), slowStream(slowMs, controller.signal)],
    controller.signal,
  ));
  const elapsed = performance.now() - start;

  assert(elapsed < 1_000, `Expected prompt exit, took ${elapsed}ms`);
  assert(items.length <= 1, `Expected at most 1 item, got ${items.length}`);
});

Deno.test("mergeWithConcurrency exits promptly when signal aborts during slow stream", async () => {
  const controller = new AbortController();
  const slowMs = 5_000;

  setTimeout(() => controller.abort(), 50);

  const start = performance.now();
  const items = await collect(mergeWithConcurrency(
    [fromArray(["fast"]), slowStream(slowMs, controller.signal)],
    1,
    controller.signal,
  ));
  const elapsed = performance.now() - start;

  assert(elapsed < 1_000, `Expected prompt exit, took ${elapsed}ms`);
  assert(items.length <= 2, `Expected at most 2 items, got ${items.length}`);
});

Deno.test("merge does not throw stream error after abort", async () => {
  const controller = new AbortController();

  async function* abortThenSlow(): AsyncGenerator<number> {
    controller.abort();
    await new Promise<void>((resolve) => {
      const id = setTimeout(resolve, 5_000);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(id);
        resolve();
      }, { once: true });
    });
    yield 1;
  }

  const start = performance.now();
  const items = await collect(merge(
    [fromArray([10]), abortThenSlow()],
    controller.signal,
  ));
  const elapsed = performance.now() - start;

  assert(elapsed < 1_000, `Expected prompt exit, took ${elapsed}ms`);
  assert(items.length <= 1);
});

async function* heldStream(
  name: string,
  release: Promise<void>,
  reached: Set<string>,
): AsyncGenerator<string> {
  yield `${name}:before`;
  await release;
  yield `${name}:after`;
  reached.add(name);
}

async function* tracked(
  name: string,
  started: Set<string>,
): AsyncGenerator<string> {
  started.add(name);
  yield name;
}

Deno.test("merge: finishStartedOnAbort yields the items started streams produce after the abort", async () => {
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  const reached = new Set<string>();

  const items: string[] = [];
  for await (
    const item of merge(
      [
        heldStream("a", release.promise, reached),
        heldStream("b", release.promise, reached),
      ],
      controller.signal,
      { finishStartedOnAbort: true },
    )
  ) {
    items.push(item);
    if (items.length === 2) {
      controller.abort();
      release.resolve();
    }
  }

  assertEquals(items.slice(2).sort(), ["a:after", "b:after"]);
  assertEquals([...reached].sort(), ["a", "b"]);
});

Deno.test("mergeWithConcurrency: finishStartedOnAbort finishes started streams and never starts queued ones", async () => {
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  const reached = new Set<string>();
  const started = new Set<string>();

  const items: string[] = [];
  for await (
    const item of mergeWithConcurrency(
      [
        heldStream("a", release.promise, reached),
        heldStream("b", release.promise, reached),
        tracked("c", started),
      ],
      2,
      controller.signal,
      { finishStartedOnAbort: true },
    )
  ) {
    items.push(item);
    if (items.length === 2) {
      controller.abort();
      release.resolve();
    }
  }

  assertEquals(items.slice(2).sort(), ["a:after", "b:after"]);
  assertEquals([...reached].sort(), ["a", "b"]);
  assertEquals(started.size, 0);
});

Deno.test("merge: finishStartedOnAbort swallows an error after the abort without cutting its sibling short", async () => {
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();

  async function* failsAfterRelease(): AsyncGenerator<string> {
    yield "a:before";
    await release.promise;
    failed.resolve();
    throw new Error("should be suppressed");
  }
  async function* finishesAfterSibling(): AsyncGenerator<string> {
    yield "b:before";
    await failed.promise;
    // A macrotask runs only once the sibling's rejection has been handled.
    await new Promise((r) => setTimeout(r, 0));
    yield "b:after";
  }

  const items: string[] = [];
  for await (
    const item of merge(
      [failsAfterRelease(), finishesAfterSibling()],
      controller.signal,
      { finishStartedOnAbort: true },
    )
  ) {
    items.push(item);
    if (items.length === 2) {
      controller.abort();
      release.resolve();
    }
  }

  assertEquals(items.slice(2), ["b:after"]);
});

Deno.test("merge: finishStartedOnAbort still rethrows an error raised before any abort", async () => {
  const controller = new AbortController();
  await assertRejects(
    () =>
      collect(merge(
        [fromArray([1, 2]), throwImmediately(new Error("stream B crashed"))],
        controller.signal,
        { finishStartedOnAbort: true },
      )),
    Error,
    "stream B crashed",
  );
});

Deno.test("merge: finishStartedOnAbort with a pre-aborted signal yields nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = new Set<string>();
  const items = await collect(merge(
    [tracked("a", started), tracked("b", started)],
    controller.signal,
    { finishStartedOnAbort: true },
  ));
  assertEquals(items, []);
  assertEquals(started.size, 0);
});

Deno.test("mergeWithConcurrency: finishStartedOnAbort with a pre-aborted signal yields nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = new Set<string>();
  const items = await collect(mergeWithConcurrency(
    [tracked("a", started), tracked("b", started), tracked("c", started)],
    1,
    controller.signal,
    { finishStartedOnAbort: true },
  ));
  assertEquals(items, []);
  assertEquals(started.size, 0);
});

class GateProbe {
  total = 0;
  peakTotal = 0;
  readonly active = new Map<string, number>();
  readonly peak = new Map<string, number>();
  readonly started = new Set<string>();

  enter(id: string, gates: readonly string[]): void {
    this.started.add(id);
    this.total++;
    this.peakTotal = Math.max(this.peakTotal, this.total);
    for (const gate of gates) {
      const n = (this.active.get(gate) ?? 0) + 1;
      this.active.set(gate, n);
      this.peak.set(gate, Math.max(this.peak.get(gate) ?? 0, n));
    }
  }

  exit(gates: readonly string[]): void {
    this.total--;
    for (const gate of gates) {
      this.active.set(gate, this.active.get(gate)! - 1);
    }
  }
}

function probed(
  probe: GateProbe,
  id: string,
  gates: readonly string[],
  release: Promise<void>,
): { stream: AsyncIterable<string>; gates: readonly string[] } {
  async function* run(): AsyncGenerator<string> {
    probe.enter(id, gates);
    yield `${id}:start`;
    await release;
    probe.exit(gates);
    yield `${id}:end`;
  }
  return { stream: run(), gates };
}

Deno.test("mergeGated: streams behind different gates run together, each gate capping its own", async () => {
  const probe = new GateProbe();
  const release = Promise.withResolvers<void>();
  const entries = [
    ...["a1", "a2", "a3"].map((id) =>
      probed(probe, id, ["a"], release.promise)
    ),
    ...["b1", "b2", "b3"].map((id) =>
      probed(probe, id, ["b"], release.promise)
    ),
  ];

  const items: string[] = [];
  let starts = 0;
  for await (
    const item of mergeGated(entries, new Map([["a", 1], ["b", 1]]))
  ) {
    items.push(item);
    if (item.endsWith(":start") && ++starts === 2) release.resolve();
  }

  assertEquals(items.length, 12);
  assertEquals(probe.peakTotal, 2);
  assertEquals(probe.peak.get("a"), 1);
  assertEquals(probe.peak.get("b"), 1);
});

Deno.test("mergeGated: a gate shared by every stream caps the total across their own gates", async () => {
  const probe = new GateProbe();
  const release = Promise.withResolvers<void>();
  const entries = [
    ...["a1", "a2", "a3"].map((id) =>
      probed(probe, id, ["a", "host"], release.promise)
    ),
    ...["b1", "b2", "b3"].map((id) =>
      probed(probe, id, ["b", "host"], release.promise)
    ),
  ];

  const items: string[] = [];
  let starts = 0;
  for await (
    const item of mergeGated(
      entries,
      new Map([["a", 2], ["b", 2], ["host", 3]]),
    )
  ) {
    items.push(item);
    if (item.endsWith(":start") && ++starts === 3) release.resolve();
  }

  assertEquals(items.length, 12);
  assertEquals(probe.peakTotal, 3);
  assert(probe.peak.get("a")! <= 2);
  assert(probe.peak.get("b")! <= 2);
});

Deno.test("mergeGated: gates without a positive limit do not hold streams back", async () => {
  const probe = new GateProbe();
  const release = Promise.withResolvers<void>();
  const entries = ["x1", "x2", "x3"].map((id) =>
    probed(probe, id, ["unlisted", "zero", "loose"], release.promise)
  );

  const items: string[] = [];
  let starts = 0;
  for await (
    const item of mergeGated(entries, new Map([["zero", 0], ["loose", 3]]))
  ) {
    items.push(item);
    if (item.endsWith(":start") && ++starts === 3) release.resolve();
  }

  assertEquals(items.length, 6);
  assertEquals(probe.peakTotal, 3);
});

Deno.test("mergeGated: an empty list yields nothing", async () => {
  assertEquals(await collect(mergeGated([], new Map([["a", 1]]))), []);
});

Deno.test("mergeGated: a stream aborted while queued on its second gate never starts and the merge still ends", async () => {
  const probe = new GateProbe();
  const controller = new AbortController();
  const release = Promise.withResolvers<void>();
  const entries = [
    probed(probe, "holder", ["host"], release.promise),
    probed(probe, "queued", ["a", "host"], release.promise),
    probed(probe, "behind", ["a"], release.promise),
  ];

  const items: string[] = [];
  for await (
    const item of mergeGated(
      entries,
      new Map([["a", 1], ["host", 1]]),
      controller.signal,
      { finishStartedOnAbort: true },
    )
  ) {
    items.push(item);
    if (item === "holder:start") {
      controller.abort();
      release.resolve();
    }
  }

  assertEquals(items, ["holder:start", "holder:end"]);
  assertEquals([...probe.started], ["holder"]);
});

Deno.test("mergeGated: a gate a stream names twice is taken once", async () => {
  const items = await collect(mergeGated(
    [
      { stream: fromArray([1]), gates: ["a", "a"] },
      { stream: fromArray([2]), gates: ["a", "a"] },
    ],
    new Map([["a", 1]]),
  ));
  assertEquals(items.sort(), [1, 2]);
});
