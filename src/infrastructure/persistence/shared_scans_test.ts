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

import { AsyncLocalStorage } from "node:async_hooks";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  currentDiagnosticTally,
  observeDiagnosticPhase,
  withDiagnosticArea,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  diagnosticPhases,
  type ReadableSpan,
  withObservedSpans,
} from "../tracing/span_test_helpers.ts";
import { SharedScans } from "./shared_scans.ts";

/** One call of a {@link gatedScans} scan, settled when the test says. */
interface GatedCall {
  window: number;
  signal: AbortSignal;
  resolve(value: string): void;
  reject(error: unknown): void;
}

/**
 * A scan whose calls each wait for the test to settle them, so every
 * ordering is decided by the test rather than by timing.
 */
function gatedScans(): {
  calls: GatedCall[];
  work: (window: number, signal: AbortSignal) => Promise<string>;
} {
  const calls: GatedCall[] = [];
  return {
    calls,
    work: (window, signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      calls.push({ window, signal, resolve, reject });
      return promise;
    },
  };
}

/** Lets the flights the calls just made schedule start. */
async function flightsStarted(): Promise<void> {
  await Promise.resolve();
}

const earliest = (a: number, b: number) => Math.min(a, b);

Deno.test("SharedScans.run: callers that arrive before the scan starts share it", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const results = [1, 2, 3].map(() => scans.run("key", 5, work));
  await flightsStarted();
  assertEquals(calls.length, 1);
  calls[0].resolve("read");
  const outcomes = await Promise.all(results);
  assertEquals(outcomes.map((o) => o.value), ["read", "read", "read"]);
  assertEquals(outcomes.map((o) => o.joined), [false, true, true]);
  assert(!scans.has("key"));
});

Deno.test("SharedScans.run: a caller arriving while a scan runs gets the next scan, started after it arrived", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const first = scans.run("key", 5, work);
  await flightsStarted();
  assertEquals(calls.length, 1);

  // Arrives while the first scan runs: a write it should see may have
  // landed after that scan listed what it reads.
  const later = [scans.run("key", 5, work), scans.run("key", 5, work)];
  await flightsStarted();
  // At most one running and one pending: the later callers wait.
  assertEquals(calls.length, 1);

  calls[0].resolve("before");
  assertEquals((await first).value, "before");
  await waitFor(() => calls.length === 2, "the next scan to start");
  calls[1].resolve("after");
  const outcomes = await Promise.all(later);
  assertEquals(outcomes.map((o) => o.value), ["after", "after"]);
  assertEquals(outcomes.map((o) => o.joined), [false, true]);
});

Deno.test("SharedScans.run: different keys do not share", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const a = scans.run("a", 1, work);
  const b = scans.run("b", 1, work);
  await flightsStarted();
  assertEquals(calls.length, 2);
  calls[0].resolve("a");
  calls[1].resolve("b");
  assertEquals((await a).value, "a");
  assertEquals((await b).value, "b");
});

Deno.test("SharedScans.run: callers joining a pending scan widen its window", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const results = [7, 3, 5].map((window) => scans.run("key", window, work));
  await flightsStarted();
  assertEquals(calls[0].window, 3);
  calls[0].resolve("read");
  await Promise.all(results);
});

Deno.test("SharedScans.run: a scan that rejects rejects every caller on it, and the next call scans again", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const failure = new Error("listing failed");
  const outcomes = [1, 2].map(() =>
    assertRejects(() => scans.run("key", 1, work))
  );
  await flightsStarted();
  calls[0].reject(failure);
  for (const outcome of outcomes) assertEquals(await outcome, failure);
  assert(!scans.has("key"));

  const again = scans.run("key", 1, work);
  await flightsStarted();
  assertEquals(calls.length, 2);
  calls[1].resolve("read");
  assertEquals((await again).value, "read");
});

Deno.test("SharedScans.run: a running scan that rejects still starts the scan pending behind it", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const failure = new Error("listing failed");
  const first = assertRejects(() => scans.run("key", 1, work));
  await flightsStarted();
  const behind = scans.run("key", 1, work);
  calls[0].reject(failure);
  assertEquals(await first, failure);
  await waitFor(() => calls.length === 2, "the pending scan to start");
  calls[1].resolve("read");
  assertEquals((await behind).value, "read");
  await waitFor(() => !scans.has("key"), "the key to be released");
});

Deno.test("SharedScans.run: a scan that throws before returning a promise rejects its callers and leaves no state", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const failure = new Error("thrown synchronously");
  const throwing = (): Promise<string> => {
    throw failure;
  };
  const outcomes = [1, 2].map(() =>
    assertRejects(() => scans.run("key", 1, throwing))
  );
  for (const outcome of outcomes) assertEquals(await outcome, failure);
  await waitFor(() => !scans.has("key"), "the key to be released");

  const again = scans.run("key", 1, work);
  await flightsStarted();
  calls[0].resolve("read");
  assertEquals((await again).value, "read");
});

Deno.test("SharedScans.run: a caller that aborts rejects with its reason, and the scan goes on for the others", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const leaving = assertRejects(() =>
    scans.run("key", 1, work, controller.signal)
  );
  const staying = scans.run("key", 1, work);
  await flightsStarted();
  controller.abort(reason);
  assertEquals(await leaving, reason);
  assert(!calls[0].signal.aborted);
  calls[0].resolve("read");
  assertEquals((await staying).value, "read");
});

Deno.test("SharedScans.run: a running scan every caller left is aborted", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const controllers = [new AbortController(), new AbortController()];
  const reason = new Error("cancelled");
  const outcomes = controllers.map((controller) =>
    assertRejects(() => scans.run("key", 1, work, controller.signal))
  );
  await flightsStarted();
  for (const controller of controllers) controller.abort(reason);
  for (const outcome of outcomes) assertEquals(await outcome, reason);
  assert(calls[0].signal.aborted);
  calls[0].reject(calls[0].signal.reason);
  await waitFor(() => !scans.has("key"), "the key to be released");
});

Deno.test("SharedScans.run: a pending scan every caller left never starts", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const running = scans.run("key", 1, work);
  await flightsStarted();

  const controller = new AbortController();
  const reason = new Error("cancelled");
  const leaving = assertRejects(() =>
    scans.run("key", 1, work, controller.signal)
  );
  controller.abort(reason);
  assertEquals(await leaving, reason);

  calls[0].resolve("read");
  assertEquals((await running).value, "read");
  await waitFor(() => !scans.has("key"), "the key to be released");
  assertEquals(calls.length, 1);
});

Deno.test("SharedScans.run: a caller whose signal already aborted rejects without a scan", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const reason = new Error("cancelled");
  assertEquals(
    await assertRejects(() =>
      scans.run("key", 1, work, AbortSignal.abort(reason))
    ),
    reason,
  );
  await flightsStarted();
  assertEquals(calls.length, 0);
  assert(!scans.has("key"));
});

Deno.test("SharedScans.run: a settled caller's abort listener is removed", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const { calls, work } = gatedScans();
  const controller = new AbortController();
  let listeners = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
    listeners++;
    add(...args);
  }) as typeof add;
  controller.signal.removeEventListener =
    ((...args: Parameters<typeof remove>) => {
      listeners--;
      remove(...args);
    }) as typeof remove;

  const result = scans.run("key", 1, work, controller.signal);
  assertEquals(listeners, 1);
  await flightsStarted();
  calls[0].resolve("read");
  await result;
  assertEquals(listeners, 0);
});

Deno.test("SharedScans.run: the scan runs outside every caller's async context", async () => {
  const context = new AsyncLocalStorage<string>();
  const scans = new SharedScans<number, string>(earliest);
  const seen: (string | undefined)[] = [];
  const gate = Promise.withResolvers<void>();
  const work = async () => {
    seen.push(context.getStore());
    await gate.promise;
    seen.push(context.getStore());
    return "read";
  };
  const running = context.run("first", () => scans.run("key", 1, work));
  await flightsStarted();
  // Created while the first scan runs, and started from its settling.
  const creator = context.run("second", () => scans.run("key", 1, work));
  const joiner = context.run("third", () => scans.run("key", 1, work));
  gate.resolve();
  await Promise.all([running, creator, joiner]);
  assertEquals(seen, [undefined, undefined, undefined, undefined]);
});

/**
 * Runs `fn` with `calls` phases of the output_search area open at once,
 * each handed its index, and returns each phase's exported attributes.
 */
async function inPhases(
  calls: number,
  fn: (index: number) => Promise<unknown>,
): Promise<ReadableSpan["attributes"][]> {
  let attributes: ReadableSpan["attributes"][] = [];
  await withObservedSpans(async (spans) => {
    await withDiagnosticArea(
      "output_search",
      () =>
        Promise.allSettled(
          Array.from({ length: calls }, (_, index) =>
            observeDiagnosticPhase(
              "candidate_scan",
              { "swamp.diagnostic.result": String(index) },
              () => fn(index),
            )),
        ),
    );
    attributes = diagnosticPhases(spans, "candidate_scan")
      .sort((a, b) =>
        Number(a.attributes["swamp.diagnostic.result"]) -
        Number(b.attributes["swamp.diagnostic.result"])
      )
      .map((span) => span.attributes);
  });
  return attributes;
}

/** A scan that counts `reads` reads into the current phase once released. */
function countingWork(gate: Promise<void>, reads: number) {
  return async () => {
    currentDiagnosticTally().add("files_read", reads);
    await gate;
    return "read";
  };
}

Deno.test("SharedScans.run: the scan's counts are reported to the caller that started it, and the others are joined", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const work = countingWork(Promise.resolve(), 4);
  const joined: boolean[] = [];
  const phases = await inPhases(3, async () => {
    joined.push((await scans.run("key", 1, work)).joined);
  });
  assertEquals(joined, [false, true, true]);
  assertEquals(phases.map((p) => p["swamp.diagnostic.files_read"]), [
    4,
    undefined,
    undefined,
  ]);
});

Deno.test("SharedScans.run: when the caller that started the scan leaves, its counts go to the earliest still waiting", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const gate = Promise.withResolvers<void>();
  const work = countingWork(gate.promise, 4);
  const controller = new AbortController();
  const joined: (boolean | undefined)[] = [undefined, undefined, undefined];
  const phases = await inPhases(3, async (index) => {
    const result = scans.run(
      "key",
      1,
      work,
      index === 0 ? controller.signal : undefined,
    );
    if (index === 2) {
      await flightsStarted();
      controller.abort(new Error("cancelled"));
      gate.resolve();
    }
    joined[index] = (await result).joined;
  });
  assertEquals(joined, [undefined, false, true]);
  assertEquals(phases.map((p) => p["swamp.diagnostic.files_read"]), [
    undefined,
    4,
    undefined,
  ]);
});

Deno.test("SharedScans.run: the last caller to leave a running scan takes what it counted", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const work = countingWork(new Promise<void>(() => {}), 4);
  const controllers = [new AbortController(), new AbortController()];
  const phases = await inPhases(2, async (index) => {
    const result = scans.run("key", 1, work, controllers[index].signal);
    if (index === 1) {
      await flightsStarted();
      for (const controller of controllers) {
        controller.abort(new Error("cancelled"));
      }
    }
    await result;
  });
  assertEquals(phases.map((p) => p["swamp.diagnostic.files_read"]), [
    undefined,
    4,
  ]);
});

Deno.test("SharedScans.run: a failed scan's counts are reported to the earliest caller on it", async () => {
  const scans = new SharedScans<number, string>(earliest);
  const work = async () => {
    currentDiagnosticTally().add("files_read", 2);
    await Promise.resolve();
    throw new Error("listing failed");
  };
  const phases = await inPhases(2, () => scans.run("key", 1, work));
  assertEquals(phases.map((p) => p["swamp.diagnostic.files_read"]), [
    2,
    undefined,
  ]);
});
