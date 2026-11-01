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
import type {
  StoredWaitRecord,
  WaitOutcome,
} from "../../domain/workflows/signal_wait_records.ts";
import type { SignalWaitStore } from "../../domain/workflows/signal_wait_store.ts";
import { withServeOutcomes } from "./serve_wait_outcomes.ts";

const WAIT = "55555555-6666-4777-8888-999999999999";

function outcome(kind: "timed_out" | "cancelled"): WaitOutcome {
  return {
    kind,
    waitId: WAIT,
    workflowId: "44444444-5555-4666-8777-888888888888",
    runId: "33333333-4444-4555-8666-777777777777",
    deadline: "2026-10-27T00:00:00.000Z",
    settledAt: "2026-10-26T00:00:00.000Z",
  };
}

/** A store of one written-once outcome, using a private field as the real one does. */
class LocalStore {
  #held: WaitOutcome | undefined;
  pendingTaken: unknown;
  findOutcome(): Promise<StoredWaitRecord<WaitOutcome>> {
    return Promise.resolve(
      this.#held === undefined
        ? { kind: "absent" }
        : { kind: "found", record: this.#held },
    );
  }
  settle(record: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>> {
    this.#held ??= record;
    return this.findOutcome();
  }
  listOutcomes(): Promise<WaitOutcome[]> {
    return Promise.resolve(this.#held === undefined ? [] : [this.#held]);
  }
}

function local(): SignalWaitStore {
  return new LocalStore() as unknown as SignalWaitStore;
}

Deno.test("withServeOutcomes: serve's outcome wins, and is kept locally for offline", async () => {
  const held = local();
  const store = withServeOutcomes(
    held,
    () => Promise.resolve(outcome("timed_out")),
  );
  const found = await store.findOutcome(WAIT);
  assertEquals(found, { kind: "found", record: outcome("timed_out") });
  assertEquals(await held.findOutcome(WAIT), found);
});

Deno.test("withServeOutcomes: a runner's settlement yields to the outcome serve holds", async () => {
  const held = local();
  const store = withServeOutcomes(
    held,
    () => Promise.resolve(outcome("timed_out")),
  );
  const settled = await store.settle(outcome("cancelled"));
  assertEquals(settled, { kind: "found", record: outcome("timed_out") });
});

Deno.test("withServeOutcomes: an unreachable or silent serve, or an outcome for another wait, leaves the local store to answer", async () => {
  for (
    const read of [
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve(undefined),
      () => Promise.resolve({ not: "an outcome" }),
      () =>
        Promise.resolve({
          ...outcome("timed_out"),
          waitId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        }),
    ]
  ) {
    const store = withServeOutcomes(local(), read);
    assertEquals(await store.findOutcome(WAIT), { kind: "absent" });
    assertEquals(await store.settle(outcome("cancelled")), {
      kind: "found",
      record: outcome("cancelled"),
    });
  }
});

Deno.test("withServeOutcomes: every other member reaches the store it wraps", async () => {
  const held = local();
  const store = withServeOutcomes(held, () => Promise.resolve(undefined));
  await held.settle(outcome("cancelled"));
  assertEquals((await store.listOutcomes()).length, 1);
  const listener = () => {};
  store.pendingTaken = listener as unknown as SignalWaitStore["pendingTaken"];
  assertEquals(held.pendingTaken, listener);
});

Deno.test("withServeOutcomes: serve having no outcome yet is never final, so the next read asks again (a lagging follower)", async () => {
  const answers = [undefined, undefined, outcome("timed_out")];
  const store = withServeOutcomes(
    local(),
    () => Promise.resolve(answers.shift()),
  );
  assertEquals(await store.findOutcome(WAIT), { kind: "absent" });
  assertEquals(await store.findOutcome(WAIT), { kind: "absent" });
  assertEquals(await store.findOutcome(WAIT), {
    kind: "found",
    record: outcome("timed_out"),
  });
});

Deno.test("withServeOutcomes: an outcome serve holds beats one this checkout settled while it could not reach it", async () => {
  let reachable = false;
  const store = withServeOutcomes(
    local(),
    () =>
      reachable
        ? Promise.resolve(outcome("timed_out"))
        : Promise.reject(new Error("503 serve_follower_behind")),
  );
  await store.settle(outcome("cancelled"));
  reachable = true;
  assertEquals(await store.findOutcome(WAIT), {
    kind: "found",
    record: outcome("timed_out"),
  });
});

Deno.test("withServeOutcomes: failing to keep serve's outcome locally still answers with it", async () => {
  const failing = {
    findOutcome: () => Promise.resolve({ kind: "absent" }),
    settle: () => Promise.reject(new Error("disk full")),
  } as unknown as SignalWaitStore;
  const store = withServeOutcomes(
    failing,
    () => Promise.resolve(outcome("timed_out")),
  );
  assertEquals((await store.findOutcome(WAIT)).kind, "found");
});
