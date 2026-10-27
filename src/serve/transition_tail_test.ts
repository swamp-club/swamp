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
import { withSpan } from "../infrastructure/tracing/mod.ts";
import {
  findSpan,
  isChildOf,
  withCapturedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";
import { TransitionTail } from "./transition_tail.ts";

Deno.test("TransitionTail: runs transitions one at a time, in order, past a failure", async () => {
  const tail = new TransitionTail("dispatch");
  const order: string[] = [];
  const gate = Promise.withResolvers<void>();

  const first = tail.run("first", async () => {
    await gate.promise;
    order.push("first");
  });
  const failing = tail.run("failing", () => {
    order.push("failing");
    return Promise.reject(new Error("boom"));
  });
  const last = tail.run("last", () => {
    order.push("last");
    return Promise.resolve("done");
  });

  gate.resolve();
  await first;
  await assertRejects(() => failing, Error, "boom");
  assertEquals(await last, "done");
  assertEquals(order, ["first", "failing", "last"]);
});

Deno.test("TransitionTail: settled waits for every transition, including one enqueued while waiting (swamp-club#3854)", async () => {
  const tail = new TransitionTail("gateway");
  const order: string[] = [];
  const gate = Promise.withResolvers<void>();
  let late: Promise<void> | undefined;

  const first = tail.run("first", async () => {
    await gate.promise;
    order.push("first");
    // Enqueued after settled() began waiting.
    late = tail.run("late", () => {
      order.push("late");
      return Promise.resolve();
    });
  });
  const settled = tail.settled().then(() => order.push("settled"));
  gate.resolve();
  await settled;
  await first;
  await late;
  assertEquals(order, ["first", "late", "settled"]);
});

Deno.test("TransitionTail: settled resolves at once with nothing queued, and past a failure", async () => {
  const tail = new TransitionTail("dispatch");
  await tail.settled();
  await assertRejects(
    () => tail.run("failing", () => Promise.reject(new Error("boom"))),
    Error,
    "boom",
  );
  await tail.settled();
});

Deno.test("TransitionTail: each transition's span records its tail, operation and the transitions ahead of it (swamp-club#3755)", async () => {
  await withCapturedSpans(async (spans) => {
    const tail = new TransitionTail("gateway");
    const gate = Promise.withResolvers<void>();

    const first = tail.run("enroll", () => gate.promise);
    const second = tail.run("worker_busy", () => Promise.resolve());
    gate.resolve();
    await Promise.all([first, second]);
    // Nothing is ahead once both settled.
    await tail.run("worker_idle", () => Promise.resolve());

    const transitions = spans.filter((s) =>
      s.name === "swamp.serve.transition"
    );
    assertEquals(
      transitions.map((s) => [
        s.attributes["swamp.transition.tail"],
        s.attributes["swamp.transition.operation"],
        s.attributes["swamp.transition.queue_depth"],
      ]),
      [
        ["gateway", "enroll", 0],
        ["gateway", "worker_busy", 1],
        ["gateway", "worker_idle", 0],
      ],
    );
    for (const span of transitions) {
      assert(
        typeof span.attributes["swamp.transition.queue_wait_ms"] === "number",
      );
    }
  });
});

Deno.test("TransitionTail: a transition that throws synchronously still ends its span and leaves the queue count", async () => {
  await withCapturedSpans(async (spans) => {
    const tail = new TransitionTail("gateway");

    await assertRejects(
      () =>
        tail.run("throws", () => {
          throw new Error("sync boom");
        }),
      Error,
      "sync boom",
    );
    await tail.run("after", () => Promise.resolve());

    const transitions = spans.filter((s) =>
      s.name === "swamp.serve.transition"
    );
    assertEquals(
      transitions.map((s) => [
        s.attributes["swamp.transition.operation"],
        s.attributes["swamp.transition.queue_depth"],
      ]),
      [["throws", 0], ["after", 0]],
    );
  });
});

Deno.test("TransitionTail: a transition's span nests under the work that enqueued it", async () => {
  await withCapturedSpans(async (spans) => {
    const tail = new TransitionTail("dispatch");
    await withSpan(
      "swamp.serve.data_plane",
      {},
      () => tail.run("step_lease.mark_writes", () => Promise.resolve()),
    );

    assert(
      isChildOf(
        findSpan(spans, "swamp.serve.transition"),
        findSpan(spans, "swamp.serve.data_plane"),
      ),
    );
  });
});

Deno.test("TransitionTail: transitions of different keys run at once, and one key's run in order (swamp-club#4038)", async () => {
  const tail = new TransitionTail("dispatch");
  const order: string[] = [];
  const held = Promise.withResolvers<void>();

  const slow = tail.run("step_lease.complete", async () => {
    await held.promise;
    order.push("a:complete");
  }, "a");
  const sameKey = tail.run("step_lease.fail", () => {
    order.push("a:fail");
    return Promise.resolve();
  }, "a");
  // Another key finishes while "a" is still held.
  await tail.run("step_lease.complete", () => {
    order.push("b:complete");
    return Promise.resolve();
  }, "b");
  assertEquals(order, ["b:complete"]);

  held.resolve();
  await Promise.all([slow, sameKey]);
  assertEquals(order, ["b:complete", "a:complete", "a:fail"]);
});

Deno.test("TransitionTail: an unkeyed transition does not wait for a keyed one", async () => {
  const tail = new TransitionTail("dispatch");
  const held = Promise.withResolvers<void>();
  const keyed = tail.run("step_lease.complete", () => held.promise, "a");
  assertEquals(await tail.run("unkeyed", () => Promise.resolve(1)), 1);
  held.resolve();
  await keyed;
});

Deno.test("TransitionTail: a keyed span counts only the transitions ahead on its key", async () => {
  await withCapturedSpans(async (spans) => {
    const tail = new TransitionTail("dispatch");
    const held = Promise.withResolvers<void>();
    const first = tail.run("step_lease.acquire", () => held.promise, "a");
    const second = tail.run(
      "step_lease.complete",
      () => Promise.resolve(),
      "a",
    );
    await tail.run("step_lease.acquire", () => Promise.resolve(), "b");
    held.resolve();
    await Promise.all([first, second]);

    assertEquals(
      spans
        .filter((s) => s.name === "swamp.serve.transition")
        .map((s) => [
          s.attributes["swamp.transition.operation"],
          s.attributes["swamp.transition.queue_depth"],
        ]),
      [
        ["step_lease.acquire", 0],
        ["step_lease.acquire", 0],
        ["step_lease.complete", 1],
      ],
    );
  });
});

Deno.test("TransitionTail: a key's chain is dropped once it drains, including after a failure", async () => {
  const tail = new TransitionTail("dispatch");
  await tail.run("ok", () => Promise.resolve(), "a");
  await assertRejects(
    () => tail.run("rejects", () => Promise.reject(new Error("boom")), "b"),
    Error,
    "boom",
  );
  await assertRejects(
    () =>
      tail.run("throws", () => {
        throw new Error("sync boom");
      }, "c"),
    Error,
    "sync boom",
  );
  assertEquals(tail.keyedChainCountForTesting, 0);

  // A key reused after its chain was dropped still runs.
  assertEquals(await tail.run("again", () => Promise.resolve(2), "a"), 2);
  assertEquals(tail.keyedChainCountForTesting, 0);
});

Deno.test("TransitionTail: settled waits for every key, including a key first enqueued while waiting", async () => {
  const tail = new TransitionTail("dispatch");
  const order: string[] = [];
  const gateA = Promise.withResolvers<void>();
  const gateB = Promise.withResolvers<void>();
  let late: Promise<void> | undefined;

  const a = tail.run("a", async () => {
    await gateA.promise;
    order.push("a");
    late = tail.run("c", () => {
      order.push("c");
      return Promise.resolve();
    }, "c");
  }, "a");
  const b = tail.run("b", async () => {
    await gateB.promise;
    order.push("b");
  }, "b");
  const settled = tail.settled().then(() => order.push("settled"));

  gateB.resolve();
  await b;
  // A full turn, so every microtask settled() could resolve on has run.
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(order, ["b"]);

  gateA.resolve();
  await settled;
  await a;
  await late;
  assertEquals(order, ["b", "a", "c", "settled"]);
});
