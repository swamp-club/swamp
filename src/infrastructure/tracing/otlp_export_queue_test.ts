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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type ExportOutcome,
  OtlpExportQueue,
  untilDeadline,
} from "./otlp_export_queue.ts";

interface Gated {
  readonly sends: number[][];
  inFlight: number;
  maxInFlight: number;
  release(): void;
}

/** a collector that answers only when released, one gate per request */
function gatedSend(): {
  state: Gated;
  send: (items: readonly number[]) => Promise<void>;
} {
  const waiting: (() => void)[] = [];
  const state: Gated = {
    sends: [],
    inFlight: 0,
    maxInFlight: 0,
    release: () => waiting.shift()?.(),
  };
  return {
    state,
    send: async (items) => {
      state.sends.push([...items]);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      state.inFlight--;
    },
  };
}

/** a collector that accepts the request and never answers */
function silentSend(signals: AbortSignal[]) {
  return (_items: readonly number[], signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  };
}

function outcomes() {
  const seen: Record<ExportOutcome, number> = {
    attempted: 0,
    acknowledged: 0,
    failed: 0,
    dropped: 0,
  };
  return {
    seen,
    onOutcome: (count: number, outcome: ExportOutcome) => {
      seen[outcome] += count;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

Deno.test("OtlpExportQueue: one send is in flight and items that end meanwhile ride the next request", async () => {
  const { state, send } = gatedSend();
  const queue = new OtlpExportQueue<number>({ send, timeoutMs: 60_000 });
  const results: boolean[] = [];
  for (let i = 0; i < 100; i++) queue.enqueue([i], (ok) => results.push(ok));

  assertEquals(state.sends.length, 1);
  state.release();
  await settle();
  assertEquals(state.sends.length, 2);
  assertEquals(state.sends[1].length, 99);
  state.release();
  await queue.shutdown();

  assertEquals(state.maxInFlight, 1);
  assertEquals(results.length, 100);
  assert(results.every((ok) => ok));
});

Deno.test("OtlpExportQueue: a request carries at most maxBatch items", async () => {
  const { state, send } = gatedSend();
  const queue = new OtlpExportQueue<number>({
    send,
    timeoutMs: 60_000,
    maxBatch: 10,
  });
  for (let i = 0; i < 25; i++) queue.enqueue([i], () => {});
  while (state.inFlight > 0) {
    state.release();
    await settle();
  }
  await queue.shutdown();

  assertEquals(state.sends.map((items) => items.length), [1, 10, 10, 4]);
});

Deno.test("OtlpExportQueue: past maxQueue items are dropped, fail at once and are counted", async () => {
  const { state, send } = gatedSend();
  const { seen, onOutcome } = outcomes();
  const queue = new OtlpExportQueue<number>({
    send,
    timeoutMs: 60_000,
    maxQueue: 5,
    onOutcome,
  });
  queue.enqueue([0], () => {});
  for (let i = 1; i <= 5; i++) queue.enqueue([i], () => {});
  let dropped: boolean | undefined;
  queue.enqueue([6, 7], (ok) => dropped = ok);

  assertEquals(dropped, false);
  assertEquals(seen.dropped, 2);
  state.release();
  await settle();
  state.release();
  await queue.shutdown();
  assertEquals(seen.acknowledged, 6);
});

Deno.test("OtlpExportQueue: shutdown against a silent collector gives up at the drain bound, aborts the send and fails the rest", async () => {
  const signals: AbortSignal[] = [];
  const { seen, onOutcome } = outcomes();
  const queue = new OtlpExportQueue<number>({
    send: silentSend(signals),
    timeoutMs: 60_000,
    drainMs: 10,
    onOutcome,
  });
  const results: boolean[] = [];
  for (let i = 0; i < 50; i++) queue.enqueue([i], (ok) => results.push(ok));

  await queue.shutdown();

  assertEquals(signals.length, 1);
  assert(signals[0].aborted);
  assertEquals(results.length, 50);
  assert(results.every((ok) => !ok));
  assertEquals(seen.failed, 1);
  assertEquals(seen.dropped, 49);
});

Deno.test("OtlpExportQueue: a send past its timeout is aborted and the next batch goes out", async () => {
  const signals: AbortSignal[] = [];
  const queue = new OtlpExportQueue<number>({
    send: silentSend(signals),
    timeoutMs: 5,
  });
  const results: boolean[] = [];
  queue.enqueue([1], (ok) => results.push(ok));
  queue.enqueue([2], (ok) => results.push(ok));

  await waitFor(() => results.length === 2, "both sends to time out");
  assertEquals(results, [false, false]);
  assertEquals(signals.length, 2);
  await queue.shutdown();
});

Deno.test("OtlpExportQueue: a refusing collector fails each export and the queue keeps sending", async () => {
  let calls = 0;
  const queue = new OtlpExportQueue<number>({
    send: () => {
      calls++;
      return Promise.reject(new Error("connection refused"));
    },
    timeoutMs: 60_000,
  });
  const results: boolean[] = [];
  for (let i = 0; i < 3; i++) queue.enqueue([i], (ok) => results.push(ok));
  await queue.forceFlush();

  assertEquals(results, [false, false, false]);
  assertEquals(calls, 2);
  await queue.shutdown();
});

Deno.test("OtlpExportQueue: an export after shutdown fails without sending", async () => {
  let calls = 0;
  const queue = new OtlpExportQueue<number>({
    send: () => {
      calls++;
      return Promise.resolve();
    },
    timeoutMs: 60_000,
  });
  await queue.shutdown();
  let result: boolean | undefined;
  queue.enqueue([1], (ok) => result = ok);

  assertEquals(result, false);
  assertEquals(calls, 0);
});

Deno.test("OtlpExportQueue: a callback that throws does not stop the queue", async () => {
  const sent: number[] = [];
  const queue = new OtlpExportQueue<number>({
    send: (items) => {
      sent.push(...items);
      return Promise.resolve();
    },
    timeoutMs: 60_000,
  });
  queue.enqueue([1], () => {
    throw new Error("processor callback");
  });
  queue.enqueue([2], () => {});
  await queue.forceFlush();

  assertEquals(sent, [1, 2]);
  await queue.shutdown();
});

Deno.test("untilDeadline: resolves at a passed deadline when the work never settles", async () => {
  await untilDeadline(new Promise(() => {}), 0, () => 1);
});

Deno.test("untilDeadline: resolves when the work settles, even by rejecting", async () => {
  await untilDeadline(
    Promise.reject(new Error("shutdown")),
    Date.now() + 60_000,
  );
});
