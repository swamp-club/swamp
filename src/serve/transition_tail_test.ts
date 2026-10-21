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
