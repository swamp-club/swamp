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

import { assert, assertEquals, assertGreater, assertLess } from "@std/assert";
import {
  createSyncGate,
  GATE_WAIT_TIMEOUT_MS,
  gatedPull,
  POLLER_ESCALATE_AFTER_SKIPS,
  POLLER_PULL_TIMEOUT_MS,
  POLLER_RETRY_MS,
  type PollerGateState,
  pollerGateTiming,
  SYNC_GATED_REQUESTS,
  withRunSyncGate,
  withSharedSyncGate,
  withSyncGate,
} from "./sync_gate.ts";
import {
  type DatastoreSyncService,
  SyncTimeoutError,
} from "../domain/datastore/datastore_sync_service.ts";
import { waitFor } from "@swamp-club/swamp-testing";
import { withDiagnosticArea } from "../domain/diagnostics/diagnostic_phase.ts";
import { SpanStatusCode, withSpan } from "../infrastructure/tracing/mod.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  withCapturedSpans,
  withObservedSpans,
} from "../infrastructure/tracing/span_test_helpers.ts";

/** Yields to the event loop so a concurrent unit can make progress. */
function tick(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

Deno.test("withSyncGate: serializes overlapping units", async () => {
  const gate = createSyncGate();
  const order: string[] = [];

  const first = withSyncGate(gate, async () => {
    order.push("first:start");
    await tick(10);
    order.push("first:end");
  });
  const second = withSyncGate(gate, () => {
    order.push("second:start");
    return Promise.resolve();
  });

  await Promise.all([first, second]);

  assertEquals(order, ["first:start", "first:end", "second:start"]);
});

Deno.test("withSyncGate: releases the gate when the unit throws", async () => {
  const gate = createSyncGate();

  await withSyncGate(gate, () => Promise.reject(new Error("boom")))
    .then(() => {
      throw new Error("expected rejection");
    }, (error: unknown) => {
      assertEquals((error as Error).message, "boom");
    });

  // A leaked permit would leave this pending forever.
  assertEquals(await withSyncGate(gate, () => Promise.resolve("ran")), "ran");
});

Deno.test("withSyncGate: traces the gate wait as a sibling of the unit's work", async () => {
  await withCapturedSpans(async (spans) => {
    const gate = createSyncGate();
    await withSpan("test.parent", {}, () =>
      withSyncGate(
        gate,
        () => withSpan("test.unit", {}, () => Promise.resolve()),
      ));
    const parent = findSpan(spans, "test.parent");
    const wait = findSpan(spans, "swamp.serve.sync_gate.wait");
    const unit = findSpan(spans, "test.unit");
    assert(isChildOf(wait, parent));
    assert(
      isChildOf(unit, parent),
      "the unit must not run under the wait span",
    );
    assertEquals(wait.attributes["sync_gate.mode"], "exclusive");
    assertEquals(wait.attributes["sync_gate.acquired"], true);
    assertEquals(wait.status.code, SpanStatusCode.OK);
  });
});

Deno.test("withSharedSyncGate: records shared mode on the gate wait span", async () => {
  await withCapturedSpans(async (spans) => {
    await withSharedSyncGate(createSyncGate(), () => Promise.resolve());
    const wait = findSpan(spans, "swamp.serve.sync_gate.wait");
    assertEquals(wait.attributes["sync_gate.mode"], "shared");
  });
});

Deno.test("withSyncGate: inside a diagnostic area the wait span is tagged gate_wait, and untagged outside", async () => {
  await withCapturedSpans(async (spans) => {
    const gate = createSyncGate();
    await withSyncGate(gate, () => Promise.resolve());
    await withDiagnosticArea(
      "output_retention",
      () => withSyncGate(gate, () => Promise.resolve()),
    );
    const waits = spans.filter((s) => s.name === "swamp.serve.sync_gate.wait");
    assertEquals(waits.length, 2);
    assertEquals(waits[0].attributes["swamp.diagnostic.phase"], undefined);
    assertEquals(
      waits[1].attributes["swamp.diagnostic.area"],
      "output_retention",
    );
    assertEquals(waits[1].attributes["swamp.diagnostic.phase"], "gate_wait");
  });
});

Deno.test("withSyncGate: a gate wait that is not acquired is an ERROR span and the unit still runs", async () => {
  await withCapturedSpans(async (spans) => {
    const gate = createSyncGate();
    // Stands in for the GATE_WAIT_TIMEOUT_MS abort without waiting 150s.
    gate.acquire = () => Promise.reject(new Error("aborted"));
    assertEquals(await withSyncGate(gate, () => Promise.resolve("ran")), "ran");
    const wait = findSpan(spans, "swamp.serve.sync_gate.wait");
    assertEquals(wait.attributes["sync_gate.acquired"], false);
    assertEquals(wait.status.code, SpanStatusCode.ERROR);
  });
});

Deno.test("withSyncGate: without a gate creates no wait span", async () => {
  await withCapturedSpans(async (spans) => {
    await withSyncGate(undefined, () => Promise.resolve());
    assertEquals(spans.length, 0);
  });
});

Deno.test("withSyncGate: without a gate returns the same promise", () => {
  const promise = Promise.resolve("value");
  assertEquals(withSyncGate(undefined, () => promise), promise);
});

Deno.test("withSyncGate: gate wait bound stays above the poller pull bound", () => {
  // A handler's fallback proceeds UNGATED, so a merely slow pull must always
  // finish before a handler queued behind it gives up — otherwise normal
  // operation silently reopens the race this module exists to close.
  assertLess(POLLER_PULL_TIMEOUT_MS, GATE_WAIT_TIMEOUT_MS);
});

Deno.test("withSharedSyncGate: shared units overlap each other", async () => {
  const gate = createSyncGate();
  let active = 0;
  let maxActive = 0;
  const unit = () =>
    withSharedSyncGate(gate, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(5);
      active--;
    });

  await Promise.all([unit(), unit(), unit()]);

  assertEquals(maxActive, 3);
  assertEquals(gate.sharedHolders, 0);
});

Deno.test("withSharedSyncGate: excludes an exclusive unit", async () => {
  const gate = createSyncGate();
  const order: string[] = [];

  const shared = withSharedSyncGate(gate, async () => {
    order.push("shared:start");
    await tick(10);
    order.push("shared:end");
  });
  const exclusive = withSyncGate(gate, () => {
    order.push("exclusive");
    return Promise.resolve();
  });

  await Promise.all([shared, exclusive]);

  assertEquals(order, ["shared:start", "shared:end", "exclusive"]);
});

Deno.test("withSharedSyncGate: releases the gate when the unit throws", async () => {
  const gate = createSyncGate();
  await withSharedSyncGate(gate, () => Promise.reject(new Error("boom")))
    .catch(() => {});
  assertEquals(gate.sharedHolders, 0);
  assertEquals(gate.tryAcquire(), true);
});

Deno.test("withSharedSyncGate: without a gate returns the same promise", () => {
  const promise = Promise.resolve("value");
  assertEquals(withSharedSyncGate(undefined, () => promise), promise);
});

Deno.test("pollerGateTiming: default interval retries every second for 25s", () => {
  assertEquals(pollerGateTiming(30_000), {
    retryMs: POLLER_RETRY_MS,
    windowMs: 25_000,
  });
});

Deno.test("pollerGateTiming: short intervals keep the window inside the interval", () => {
  const { retryMs, windowMs } = pollerGateTiming(20);
  assertEquals(retryMs, 1);
  assertLess(windowMs, 20);
  assertGreater(windowMs, 0);
});

/** A delay that resolves at once and runs `onCall` with the call count. */
function instantDelay(onCall: (calls: number) => void = () => {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    delay: () => {
      calls++;
      onCall(calls);
      return Promise.resolve();
    },
  };
}

const FAST_TIMING = { retryMs: 1, windowMs: 5 };

Deno.test("gatedPull: pulls at once when the gate is free", async () => {
  const gate = createSyncGate();
  const state: PollerGateState = { consecutiveSkips: 2 };
  const delay = instantDelay();

  const result = await gatedPull(gate, "test", () => Promise.resolve(7), {
    state,
    timing: FAST_TIMING,
    delay: delay.delay,
  });

  assertEquals(result, 7);
  assertEquals(delay.calls, 0);
  assertEquals(state.consecutiveSkips, 0, "acquiring resets the skip count");
  assertEquals(gate.exclusiveHeld, false);
});

Deno.test("gatedPull: retries while run pushes hold the gate, then pulls once they finish", async () => {
  const gate = createSyncGate();
  await gate.acquireShared();
  const delay = instantDelay((calls) => {
    // Opportunistic phase: the poller must never hold a queue slot, or it
    // would make the run pushes behind it wait.
    assertEquals(gate.waiters, 0);
    if (calls === 3) gate.releaseShared();
  });
  let pulls = 0;

  await gatedPull(gate, "test", () => {
    pulls++;
    return Promise.resolve();
  }, { timing: FAST_TIMING, delay: delay.delay });

  assertEquals(pulls, 1);
  assertEquals(delay.calls, 3);
});

Deno.test("gatedPull: a waiting poller never blocks a new shared acquirer", async () => {
  const gate = createSyncGate();
  await gate.acquireShared();
  let lateShared = false;
  const delay = instantDelay((calls) => {
    if (calls === 1) {
      // A run push arriving while the poller retries is admitted at once.
      gate.acquireShared().then(() => {
        lateShared = true;
      });
    }
  });

  await gatedPull(gate, "test", () => Promise.resolve(), {
    timing: FAST_TIMING,
    delay: delay.delay,
  });
  await Promise.resolve();

  assertEquals(lateShared, true);
  assertEquals(gate.sharedHolders, 2);
});

Deno.test("gatedPull: skips the cycle, never pulling ungated, when the gate stays busy", async () => {
  const gate = createSyncGate();
  await gate.acquireShared();
  const state: PollerGateState = { consecutiveSkips: 0 };
  let pulls = 0;

  const result = await gatedPull(gate, "test", () => {
    pulls++;
    return Promise.resolve(1);
  }, { state, timing: FAST_TIMING, delay: instantDelay().delay });

  assertEquals(result, undefined);
  assertEquals(pulls, 0);
  assertEquals(state.consecutiveSkips, 1);
  assertEquals(gate.waiters, 0);
});

Deno.test("gatedPull: escalates to a queued wait after consecutive skips", async () => {
  const gate = createSyncGate();
  await gate.acquireShared();
  const state: PollerGateState = {
    consecutiveSkips: POLLER_ESCALATE_AFTER_SKIPS,
  };
  let pulls = 0;

  const pending = gatedPull(gate, "test", () => {
    pulls++;
    return Promise.resolve();
  }, { state, timing: FAST_TIMING, delay: instantDelay().delay });

  // Escalated: the poller holds a queue slot, so a run push arriving now
  // waits behind it — the one bounded stall the policy allows.
  await waitFor(() => gate.waiters === 1, "poller queued for the gate");
  let lateShared = false;
  const late = gate.acquireShared().then(() => {
    lateShared = true;
  });
  await Promise.resolve();
  assertEquals(lateShared, false);

  gate.releaseShared();
  await pending;
  await late;

  assertEquals(pulls, 1);
  assertEquals(state.consecutiveSkips, 0);
  assertEquals(lateShared, true);
  gate.releaseShared();
});

Deno.test("gatedPull: stop ends the opportunistic retry at once, as an uncounted skip", async () => {
  const gate = createSyncGate();
  await gate.acquireShared();
  const state: PollerGateState = { consecutiveSkips: 0 };
  const stop = new AbortController();
  let pulls = 0;

  await gatedPull(gate, "test", () => {
    pulls++;
    return Promise.resolve();
  }, {
    state,
    signal: stop.signal,
    timing: { retryMs: 1, windowMs: 1_000_000 },
    delay: instantDelay((calls) => {
      if (calls === 2) stop.abort();
    }).delay,
  });

  assertEquals(pulls, 0);
  assertEquals(state.consecutiveSkips, 0);
  gate.releaseShared();
});

Deno.test("gatedPull: stop ends an escalated wait at once and leaves the queue", async () => {
  const gate = createSyncGate();
  await gate.acquireShared();
  const stop = new AbortController();
  let pulls = 0;

  const pending = gatedPull(gate, "test", () => {
    pulls++;
    return Promise.resolve();
  }, {
    state: { consecutiveSkips: POLLER_ESCALATE_AFTER_SKIPS },
    signal: stop.signal,
  });
  await waitFor(() => gate.waiters === 1, "poller queued for the gate");

  stop.abort();
  await pending;

  assertEquals(pulls, 0);
  assertEquals(gate.waiters, 0);
  gate.releaseShared();
  assertEquals(gate.tryAcquire(), true);
});

Deno.test("gatedPull: without a gate pulls directly", async () => {
  assertEquals(await gatedPull(undefined, "test", () => Promise.resolve(3)), 3);
});

Deno.test("SYNC_GATED_REQUESTS: excludes the long-running run verbs", () => {
  for (const verb of ["model.method.run", "workflow.run", "workflow.resume"]) {
    assertEquals(
      SYNC_GATED_REQUESTS.has(verb),
      false,
      `${verb} must not hold the gate for a whole run`,
    );
  }
  assertGreater(SYNC_GATED_REQUESTS.size, 0);
});

/**
 * Datastore honouring the documented sync contract: `pushChanged` deletes the
 * remote object for a dirty path that is absent on disk and uploads one that
 * is present (`DatastoreSyncService.markDirty` rule 2). The pull reads the
 * remote index first and writes files afterwards, which is the window
 * swamp-club#2247 is about.
 */
function createFakeDatastore() {
  const remote = new Set<string>(["data/item"]);
  const local = new Set<string>(["data/item"]);
  const dirty = new Set<string>();

  const syncService: DatastoreSyncService = {
    async pullChanged() {
      // Read the remote index, then download — the window the gate closes.
      const indexSnapshot = [...remote];
      await tick(0);
      let pulled = 0;
      for (const path of indexSnapshot) {
        if (!local.has(path)) {
          local.add(path);
          pulled++;
        }
      }
      return pulled;
    },
    async pushChanged() {
      await tick(0);
      for (const path of dirty) {
        if (local.has(path)) remote.add(path);
        else remote.delete(path);
      }
      dirty.clear();
    },
    markDirty(options) {
      if (options?.relPath) dirty.add(options.relPath);
      return Promise.resolve();
    },
  };

  return { syncService, remote, local, dirty };
}

Deno.test("sync gate: a pull cannot resurrect an item deleted under the gate", async () => {
  const datastore = createFakeDatastore();
  const gate = createSyncGate();

  const pull = gatedPull(
    gate,
    "test poller",
    (signal) => datastore.syncService.pullChanged({ signal }),
  );
  const mutation = withSyncGate(gate, async () => {
    await datastore.syncService.markDirty({ relPath: "data/item" });
    datastore.local.delete("data/item");
    await tick(5);
    await datastore.syncService.pushChanged({});
  });

  await Promise.all([pull, mutation]);

  assertEquals(
    datastore.remote.has("data/item"),
    false,
    "the delete must survive an overlapping datastore pull",
  );
});

Deno.test("sync gate: the same interleaving resurrects the item without a gate", async () => {
  // Teeth for the test above: this is swamp-club#2247 itself. The pull's
  // download lands after the local removal, so the push sees the dirty path
  // present on disk and re-uploads instead of deleting.
  const datastore = createFakeDatastore();

  const pull = datastore.syncService.pullChanged({});
  const mutation = (async () => {
    await datastore.syncService.markDirty({ relPath: "data/item" });
    datastore.local.delete("data/item");
    await tick(5);
    await datastore.syncService.pushChanged({});
  })();

  await Promise.all([pull, mutation]);

  assertEquals(datastore.remote.has("data/item"), true);
});

Deno.test("withSharedSyncGate: a run pull waits for a run push in flight, while pushes run together (swamp-club#3146)", async () => {
  const gate = createSyncGate();
  const order: string[] = [];
  let finishPush: () => void = () => {};
  const pushing = new Promise<void>((resolve) => finishPush = resolve);
  const push = withSharedSyncGate(gate, async () => {
    order.push("push start");
    await pushing;
    order.push("push end");
  });
  const secondPush = withSharedSyncGate(gate, () => {
    order.push("second push");
    return Promise.resolve();
  });
  await waitFor(() => order.length === 2, "both pushes started");
  const pull = withSharedSyncGate(gate, () => {
    order.push("pull");
    return Promise.resolve();
  }, "pull");
  await secondPush;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(order, ["push start", "second push"]);

  finishPush();
  await Promise.all([push, pull]);
  assertEquals(order, ["push start", "second push", "push end", "pull"]);
});

Deno.test("withRunSyncGate: a push that must run alone takes the gate exclusively (swamp-club#3146)", async () => {
  const gate = createSyncGate();
  let finishPull: () => void = () => {};
  const pulling = new Promise<void>((resolve) => finishPull = resolve);
  const order: string[] = [];
  const pull = withRunSyncGate(gate, async () => {
    order.push("pull start");
    await pulling;
    order.push("pull end");
  }, "pull");
  await waitFor(() => order.length === 1, "the pull started");
  const alone = withRunSyncGate(gate, () => {
    order.push(`alone (exclusive=${gate.exclusiveHeld})`);
    return Promise.resolve();
  }, "push-alone");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(order, ["pull start"]);

  finishPull();
  await Promise.all([pull, alone]);
  assertEquals(order, ["pull start", "pull end", "alone (exclusive=true)"]);
});

// Diagnostic phases of a gated pull in the access_poll area (swamp-club#4005).

Deno.test("gatedPull: in the access_poll area the wait and the pull are sibling phases", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    const result = await withSpan(
      "outer",
      {},
      () =>
        withDiagnosticArea(
          "access_poll",
          () =>
            gatedPull(gate, "test", () => Promise.resolve(4), {
              state: { consecutiveSkips: 2 },
              timing: FAST_TIMING,
              delay: instantDelay().delay,
            }),
        ),
    );
    assertEquals(result, 4);
    const outer = findSpan(spans, "outer");
    const wait = findSpan(spans, "swamp.diagnostic.gate_wait");
    const pull = findSpan(spans, "swamp.diagnostic.remote_pull");
    assert(isChildOf(wait, outer));
    assert(isChildOf(pull, outer));
    assert(spans.indexOf(wait) < spans.indexOf(pull));
    assertEquals(
      wait.attributes["swamp.diagnostic.gate_mode"],
      "opportunistic",
    );
    assertEquals(wait.attributes["swamp.diagnostic.consecutive_skips"], 2);
    assertEquals(wait.attributes["swamp.diagnostic.acquired"], true);
    assertEquals(wait.attributes["swamp.diagnostic.attempts"], 1);
    assertEquals(wait.attributes["swamp.outcome"], "ok");
    assertEquals(pull.attributes["swamp.diagnostic.changed"], 4);
    assertEquals(pull.attributes["swamp.diagnostic.count_reported"], true);
    assertEquals(pull.attributes["swamp.outcome"], "ok");
  });
});

Deno.test("gatedPull: a skipped cycle is a gate_wait that did not acquire, ok and with no pull", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    await gate.acquireShared();
    const state: PollerGateState = { consecutiveSkips: 0 };
    await withDiagnosticArea(
      "access_poll",
      () =>
        gatedPull(gate, "test", () => Promise.resolve(1), {
          state,
          timing: FAST_TIMING,
          delay: instantDelay().delay,
        }),
    );
    gate.releaseShared();
    const wait = findSpan(spans, "swamp.diagnostic.gate_wait");
    assertEquals(wait.attributes["swamp.diagnostic.acquired"], false);
    assertEquals(wait.attributes["swamp.outcome"], "ok");
    // One try at 0, 1, ... 5ms of a 5ms window, every 1ms.
    assertEquals(wait.attributes["swamp.diagnostic.attempts"], 6);
    assertEquals(diagnosticPhases(spans, "remote_pull").length, 0);
    assertEquals(state.consecutiveSkips, 1);
  });
});

Deno.test("gatedPull: a stop during the wait ends gate_wait cancelled", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    await gate.acquireShared();
    const stop = new AbortController();
    await withDiagnosticArea(
      "access_poll",
      () =>
        gatedPull(gate, "test", () => Promise.resolve(1), {
          signal: stop.signal,
          timing: { retryMs: 1, windowMs: 1_000_000 },
          delay: instantDelay((calls) => {
            if (calls === 2) stop.abort();
          }).delay,
        }),
      stop.signal,
    );
    gate.releaseShared();
    const wait = findSpan(spans, "swamp.diagnostic.gate_wait");
    assertEquals(wait.attributes["swamp.diagnostic.acquired"], false);
    assertEquals(wait.attributes["swamp.outcome"], "cancelled");
    assertEquals(wait.attributes["swamp.diagnostic.cancel_observed"], true);
    assertEquals(diagnosticPhases(spans, "remote_pull").length, 0);
  });
});

Deno.test("gatedPull: a queued wait that runs out its bound ends gate_wait timeout", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    await gate.acquireShared();
    const state: PollerGateState = {
      consecutiveSkips: POLLER_ESCALATE_AFTER_SKIPS,
    };
    // The bound's timer is unref'd, so a ref'd tick keeps the loop alive.
    await Promise.all([
      withDiagnosticArea(
        "access_poll",
        () =>
          gatedPull(gate, "test", () => Promise.resolve(1), {
            state,
            queuedWaitMs: 1,
          }),
      ),
      tick(20),
    ]);
    gate.releaseShared();
    const wait = findSpan(spans, "swamp.diagnostic.gate_wait");
    assertEquals(wait.attributes["swamp.diagnostic.gate_mode"], "queued");
    assertEquals(wait.attributes["swamp.diagnostic.acquired"], false);
    assertEquals(wait.attributes["swamp.outcome"], "timeout");
    assertEquals(diagnosticPhases(spans, "remote_pull").length, 0);
    assertEquals(state.consecutiveSkips, POLLER_ESCALATE_AFTER_SKIPS + 1);
  });
});

Deno.test("gatedPull: without a gate exports only the pull, and a pull with no count says so", async () => {
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea(
      "access_poll",
      () => gatedPull(undefined, "test", () => Promise.resolve()),
    );
    assertEquals(diagnosticPhases(spans, "gate_wait").length, 0);
    const pull = findSpan(spans, "swamp.diagnostic.remote_pull");
    assertEquals(pull.attributes["swamp.diagnostic.count_reported"], false);
    assertEquals(pull.attributes["swamp.diagnostic.changed"], undefined);
  });
});

Deno.test("gatedPull: a pull that times out ends remote_pull timeout, and one that throws ends error", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    for (
      const error of [
        new SyncTimeoutError("test", "pull", 5),
        new Error("bucket unreachable"),
      ]
    ) {
      let thrown: unknown;
      try {
        await withDiagnosticArea(
          "access_poll",
          () =>
            gatedPull(gate, "test", () => Promise.reject(error), {
              timing: FAST_TIMING,
              delay: instantDelay().delay,
            }),
        );
      } catch (caught) {
        thrown = caught;
      }
      assertEquals(thrown, error);
      assertEquals(gate.exclusiveHeld, false);
    }
    const [timedOut, failed] = diagnosticPhases(spans, "remote_pull");
    assertEquals(timedOut.attributes["swamp.outcome"], "timeout");
    assertEquals(failed.attributes["swamp.outcome"], "error");
    assertEquals(timedOut.status.code, SpanStatusCode.ERROR);
  });
});

Deno.test("gatedPull: outside a diagnostic area, as the config and runtime pollers call it, exports no phases", async () => {
  await withObservedSpans(async (spans) => {
    const gate = createSyncGate();
    await gatedPull(gate, "test", () => Promise.resolve(2), {
      timing: FAST_TIMING,
      delay: instantDelay().delay,
    });
    assertEquals(
      spans.filter((s) => s.name.startsWith("swamp.diagnostic.")).length,
      0,
    );
  });
});
