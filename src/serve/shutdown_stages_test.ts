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
import { waitFor } from "@swamp-club/swamp-testing";
import { ShutdownDeadline } from "./shutdown_deadline.ts";
import { ShutdownStages } from "./shutdown_stages.ts";
import { WorkerGcService } from "./worker_gc_service.ts";
import { ConfigPoller } from "./config_poller.ts";

function deadlineWithMsLeft(ms: number): ShutdownDeadline {
  return ShutdownDeadline.forShutdown(0, 0, { now: () => 0, budgetMs: ms });
}

function spentDeadline(): ShutdownDeadline {
  return ShutdownDeadline.forShutdown(0, 0, { now: () => 1_000, budgetMs: 0 });
}

Deno.test("ShutdownStages.run: a stage that settles is done", async () => {
  const stages = new ShutdownStages(deadlineWithMsLeft(5_000));
  let ran = false;
  const outcome = await stages.run("poller", () => {
    ran = true;
    return Promise.resolve();
  });
  assertEquals(outcome, "done");
  assertEquals(ran, true);
});

Deno.test("ShutdownStages.run: a stage with nothing in flight is done with no time left", async () => {
  const timedOut: string[] = [];
  const stages = new ShutdownStages(spentDeadline(), {
    onTimedOut: (stage) => timedOut.push(stage),
  });
  const outcome = await stages.run("worker GC", async () => {
    await Promise.resolve();
  });
  assertEquals(outcome, "done");
  assertEquals(timedOut, []);
});

Deno.test("ShutdownStages.run: a failing stage resolves failed and the next stage still runs", async () => {
  const stages = new ShutdownStages(deadlineWithMsLeft(5_000));
  const failed = await stages.run(
    "pollers",
    () => Promise.reject(new Error("pull exploded")),
  );
  const throwing = await stages.run("sync throw", () => {
    throw new Error("thrown before a promise");
  });
  let nextRan = false;
  const next = await stages.run("audit", () => {
    nextRan = true;
    return Promise.resolve();
  });
  assertEquals([failed, throwing, next], ["failed", "failed", "done"]);
  assertEquals(nextRan, true);
});

Deno.test("ShutdownStages.run: a stage that never settles times out and is reported", async () => {
  const timedOut: string[] = [];
  const stages = new ShutdownStages(deadlineWithMsLeft(20), {
    onTimedOut: (stage) => timedOut.push(stage),
  });
  const outcome = await stages.run("retention GC", () => new Promise(() => {}));
  assertEquals(outcome, "timed_out");
  assertEquals(timedOut, ["retention GC"]);
});

Deno.test("ShutdownStages.run: a floored stage gets one attempt once the budget is spent", async () => {
  const stages = new ShutdownStages(spentDeadline());
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  const floored = await stages.run("audit", () => promise, "floor");
  assertEquals(floored, "done");
  const unfloored = await stages.run(
    "continuation sweep",
    () => new Promise(() => {}),
  );
  assertEquals(unfloored, "timed_out");
});

Deno.test("ShutdownStages.run: a self-capped stage is awaited, never raced", async () => {
  const timedOut: string[] = [];
  const stages = new ShutdownStages(spentDeadline(), {
    onTimedOut: (stage) => timedOut.push(stage),
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 20);
  const outcome = await stages.run("v3 replication", () => promise, "self");
  assertEquals(outcome, "done");
  assertEquals(timedOut, []);
});

Deno.test("ShutdownStages.run: a worker GC sweep stuck in a query no longer holds shutdown", async () => {
  const query = Promise.withResolvers<never>();
  let sweepStarted = false;
  const svc = new WorkerGcService({
    intervalMs: 60_000,
    initialDelayMs: 0,
    gracePeriodMs: 1_000,
    runPrune: () => {
      sweepStarted = true;
      return query.promise;
    },
  });
  svc.start();
  await waitFor(() => sweepStarted, "worker GC sweep started");
  const stages = new ShutdownStages(deadlineWithMsLeft(20));
  const order: string[] = [];
  order.push(await stages.run("worker GC", () => svc.dispose()));
  order.push(await stages.run("next stage", () => Promise.resolve()));
  assertEquals(order, ["timed_out", "done"]);
  query.reject(new Error("released by the test"));
  await svc.dispose();
});

Deno.test("ShutdownStages.run: a config poll stuck mid-pull no longer holds shutdown", async () => {
  const hash = Promise.withResolvers<string | null>();
  let pulling = false;
  const poller = new ConfigPoller({
    catalogInvalidate: () => {},
    extensionReloader: () => Promise.resolve({ status: "ok", errors: [] }),
    lockfileHash: () => {
      pulling = true;
      return hash.promise;
    },
    pollIntervalMs: 60_000,
  });
  poller.start();
  poller.pollNow();
  await waitFor(() => pulling, "config poll started");
  const stages = new ShutdownStages(deadlineWithMsLeft(20));
  const outcome = await stages.run("config poller", () => poller.stop());
  assertEquals(outcome, "timed_out");
  hash.resolve(null);
  await poller.stop();
});
