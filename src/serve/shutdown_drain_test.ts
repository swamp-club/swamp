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
import {
  cleanupGraceWithin,
  type DrainableRunRegistry,
  type DrainableTriggerSource,
  runShutdownDrain,
  SHUTDOWN_ABORT_MESSAGE,
  type StoppedTriggerRun,
} from "./shutdown_drain.ts";
import type { ActiveRun } from "./active_run_registry.ts";
import {
  isInterruption,
  RunInterruption,
} from "../domain/workflows/run_interruption.ts";
import { CLEANUP_GRACE_TIMEOUT_MS } from "../domain/models/cancel_cause.ts";
import { RunEventBuffer } from "./run_event_buffer.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

class FakeSource implements DrainableTriggerSource {
  readonly calls: string[] = [];
  constructor(
    private readonly log: string[],
    private readonly name: string,
    private readonly drainImpl: () => Promise<void> = () => Promise.resolve(),
  ) {}
  drain(timeoutMs: number): Promise<void> {
    this.log.push(`${this.name}.drain(${timeoutMs})`);
    return this.drainImpl();
  }
  aborted: StoppedTriggerRun[] = [];
  graces: (number | undefined)[] = [];
  cleanupGraces: (number | undefined)[] = [];
  stopGate: Promise<void> = Promise.resolve();
  stop(
    abortGraceMs?: number,
    cleanupGraceMs?: number,
  ): Promise<readonly StoppedTriggerRun[]> {
    this.log.push(`${this.name}.stop`);
    this.graces.push(abortGraceMs);
    this.cleanupGraces.push(cleanupGraceMs);
    return this.stopGate.then(() => this.aborted);
  }
  unsettled = false;
  hasUnsettledRuns(): boolean {
    return this.unsettled;
  }
}

function fakeRun(runId: string): ActiveRun {
  return {
    runId,
    kind: "workflow-run",
    resourceName: "wf",
    buffer: new RunEventBuffer(1),
    controller: new AbortController(),
    startedAt: new Date(),
    completion: Promise.resolve(),
    principalId: null,
  };
}

class FakeRegistry implements DrainableRunRegistry {
  constructor(
    private readonly log: string[],
    private runs: ActiveRun[],
    private readonly drainImpl: () => Promise<void> = () => Promise.resolve(),
  ) {}
  draining = false;
  get size(): number {
    return this.runs.length;
  }
  beginDraining(): void {
    this.draining = true;
  }
  drainAll(timeoutMs: number): Promise<void> {
    this.log.push(`registry.drainAll(${timeoutMs})`);
    return this.drainImpl();
  }
  list(): ReadonlyArray<ActiveRun> {
    return this.runs;
  }
  finishAll(): void {
    this.runs = [];
  }
}

Deno.test("runShutdownDrain: drains every source concurrently under one deadline before stopping", async () => {
  const log: string[] = [];
  const gate = Promise.withResolvers<void>();
  const registry = new FakeRegistry(log, [fakeRun("r1")], async () => {
    await gate.promise;
    registry.finishAll();
  });
  const webhooks = new FakeSource(log, "webhooks", () => gate.promise);
  const schedules = new FakeSource(log, "schedules", () => gate.promise);

  const done = runShutdownDrain({
    webhookService: webhooks,
    scheduledExecution: schedules,
    activeRunRegistry: registry,
    drainTimeoutMs: 45_000,
    abortGraceMs: 5_000,
  });
  assertEquals(log, [
    "webhooks.drain(45000)",
    "schedules.drain(45000)",
    "registry.drainAll(45000)",
  ]);
  gate.resolve();
  const aborted = await done;

  assertEquals(aborted, []);
  assertEquals(log.slice(3), ["webhooks.stop", "schedules.stop"]);
});

Deno.test("runShutdownDrain: a zero timeout skips the registry wait and aborts at once", async () => {
  const log: string[] = [];
  const run = fakeRun("r1");
  const registry = new FakeRegistry(log, [run]);
  const undrained: number[] = [];

  const aborted = await runShutdownDrain({
    webhookService: new FakeSource(log, "webhooks"),
    scheduledExecution: null,
    activeRunRegistry: registry,
    drainTimeoutMs: 0,
    abortGraceMs: 5_000,
    onAborting: (n) => undrained.push(n),
  });

  assertEquals(log, [
    "webhooks.drain(0)",
    "webhooks.stop",
    "registry.drainAll(5000)",
  ]);
  assertEquals(undrained, [1]);
  assertEquals(aborted.map((r) => r.runId), ["r1"]);
  assertEquals(run.controller.signal.aborted, true);
});

Deno.test("runShutdownDrain: a rejected drain still stops sources and aborts leftovers", async () => {
  const log: string[] = [];
  const run = fakeRun("r1");

  const aborted = await runShutdownDrain({
    webhookService: new FakeSource(log, "webhooks"),
    scheduledExecution: new FakeSource(
      log,
      "schedules",
      () => Promise.reject(new Error("boom")),
    ),
    activeRunRegistry: new FakeRegistry(log, [run]),
    drainTimeoutMs: 1_000,
    abortGraceMs: 5_000,
  });

  assertEquals(log.includes("webhooks.stop"), true);
  assertEquals(log.includes("schedules.stop"), true);
  assertEquals(aborted.map((r) => r.runId), ["r1"]);
  assertEquals(run.controller.signal.aborted, true);
});

Deno.test("runShutdownDrain: with nothing configured returns no aborted runs", async () => {
  const aborted = await runShutdownDrain({
    webhookService: null,
    scheduledExecution: null,
    activeRunRegistry: null,
    drainTimeoutMs: 30_000,
    abortGraceMs: 5_000,
  });
  assertEquals(aborted, []);
});

Deno.test("runShutdownDrain: refuses later registrations even when nothing is drained", async () => {
  // a chained auto-resume can register after shutdown begins, so the registry
  // must stop accepting runs even when no drain waited
  for (const drainTimeoutMs of [0, 30_000]) {
    const registry = new FakeRegistry([], []);
    await runShutdownDrain({
      webhookService: null,
      scheduledExecution: null,
      activeRunRegistry: registry,
      drainTimeoutMs,
      abortGraceMs: 5_000,
    });
    assertEquals(registry.draining, true);
  }
});

Deno.test("runShutdownDrain: returns the webhook and cron runs the sources aborted, beside the registry's, for shutdown to interrupt", async () => {
  const log: string[] = [];
  const startedAt = new Date("2026-11-12T10:00:00Z");
  const apiRun = fakeRun("api-1");
  const webhooks = new FakeSource(log, "webhooks");
  webhooks.aborted = [{
    runId: "hook-1",
    workflowId: "wf-hook",
    workflowName: "deploy",
    startedAt,
  }];
  const schedules = new FakeSource(log, "schedules");
  schedules.aborted = [{ runId: "cron-1", workflowName: "nightly", startedAt }];

  const aborted = await runShutdownDrain({
    webhookService: webhooks,
    scheduledExecution: schedules,
    activeRunRegistry: new FakeRegistry(log, [apiRun]),
    drainTimeoutMs: 0,
    abortGraceMs: 5_000,
  });

  assertEquals(aborted[0], apiRun);
  assertEquals(aborted.slice(1), [
    {
      runId: "hook-1",
      kind: "workflow-run",
      resourceName: "deploy",
      resourceId: "wf-hook",
      startedAt,
    },
    {
      runId: "cron-1",
      kind: "workflow-run",
      resourceName: "nightly",
      startedAt,
    },
  ]);
});

Deno.test("runShutdownDrain: a source whose stop fails contributes no runs and the rest still stop", async () => {
  const log: string[] = [];
  const failing = new FakeSource(log, "webhooks");
  failing.stop = () => Promise.reject(new Error("boom"));
  const schedules = new FakeSource(log, "schedules");
  const startedAt = new Date();
  schedules.aborted = [{ runId: "cron-1", workflowName: "nightly", startedAt }];

  const aborted = await runShutdownDrain({
    webhookService: failing,
    scheduledExecution: schedules,
    activeRunRegistry: null,
    drainTimeoutMs: 0,
    abortGraceMs: 5_000,
  });

  assertEquals(aborted.map((run) => run.runId), ["cron-1"]);
});

Deno.test("runShutdownDrain: aborts registry runs as an interruption, so the run is continued rather than cleaned up", async () => {
  const log: string[] = [];
  const run = fakeRun("r1");

  await runShutdownDrain({
    webhookService: null,
    scheduledExecution: null,
    activeRunRegistry: new FakeRegistry(log, [run]),
    drainTimeoutMs: 0,
    abortGraceMs: 5_000,
  });

  assertEquals(isInterruption(run.controller.signal), true);
});

Deno.test("runShutdownDrain: stops both sources with the abort grace and aborts the registry runs alongside, not after them", async () => {
  const log: string[] = [];
  const run = fakeRun("r1");
  const webhooks = new FakeSource(log, "webhooks");
  const schedules = new FakeSource(log, "schedules");
  const stopping = Promise.withResolvers<void>();
  webhooks.stopGate = stopping.promise;
  schedules.stopGate = stopping.promise;

  const done = runShutdownDrain({
    webhookService: webhooks,
    scheduledExecution: schedules,
    activeRunRegistry: new FakeRegistry(log, [run]),
    drainTimeoutMs: 0,
    abortGraceMs: 5_000,
  });
  await waitFor(
    () => log.includes("registry.drainAll(5000)"),
    "the registry's abort grace",
  );
  assertEquals(run.controller.signal.aborted, true);
  stopping.resolve();
  await done;

  assertEquals(webhooks.graces, [5_000]);
  assertEquals(schedules.graces, [5_000]);
});

Deno.test("runShutdownDrain: a registry run a user cancelled first keeps its cancel reason, is waited for up to one cleanup grace more, and is reported for settling only if it outlasts that", async () => {
  for (const finishes of [false, true]) {
    const log: string[] = [];
    const cancelled = fakeRun("cancelled-1");
    cancelled.controller.abort(new Error("cancelled by user:alice"));
    const live = fakeRun("live-1");
    const registry: FakeRegistry = new FakeRegistry(
      log,
      [cancelled, live],
      () => {
        if (finishes) registry.finishAll();
        return Promise.resolve();
      },
    );

    const aborted = await runShutdownDrain({
      webhookService: null,
      scheduledExecution: null,
      activeRunRegistry: registry,
      drainTimeoutMs: 0,
      abortGraceMs: 5_000,
    });

    assertEquals(isInterruption(cancelled.controller.signal), false);
    assertEquals(isInterruption(live.controller.signal), true);
    assertEquals(log, [
      `registry.drainAll(${CLEANUP_GRACE_TIMEOUT_MS + 5_000})`,
    ]);
    assertEquals(
      aborted.map((run) => [run.runId, run.cancelledBeforeShutdown]),
      finishes
        ? [["live-1", undefined]]
        : [["live-1", undefined], ["cancelled-1", {
          reason: "cancelled by user:alice",
        }]],
      finishes ? "finished" : "outlasted",
    );
  }
});

Deno.test("cleanupGraceWithin: what is left of the deadline less the reserve, at most the cleanup grace and never negative", () => {
  assertEquals(cleanupGraceWithin(22_000, 10_000), 12_000);
  assertEquals(cleanupGraceWithin(120_000, 10_000), CLEANUP_GRACE_TIMEOUT_MS);
  assertEquals(cleanupGraceWithin(4_000, 10_000), 0);
});

Deno.test("runShutdownDrain: reads the cleanup grace once the drain ends and hands it to every source and the registry wait", async () => {
  const log: string[] = [];
  const gate = Promise.withResolvers<void>();
  let drained = false;
  const cancelled = fakeRun("cancelled-1");
  cancelled.controller.abort(new Error("cancelled by user"));
  const webhooks = new FakeSource(log, "webhooks", async () => {
    await gate.promise;
    drained = true;
  });
  const schedules = new FakeSource(log, "schedules");
  const readAtDrainEnd: boolean[] = [];

  const done = runShutdownDrain({
    webhookService: webhooks,
    scheduledExecution: schedules,
    activeRunRegistry: new FakeRegistry(log, [cancelled]),
    drainTimeoutMs: 45_000,
    abortGraceMs: 5_000,
    cleanupGraceMs: () => {
      readAtDrainEnd.push(drained);
      return 1_000;
    },
  });
  gate.resolve();
  await done;

  assertEquals(readAtDrainEnd, [true]);
  assertEquals(webhooks.cleanupGraces, [1_000]);
  assertEquals(schedules.cleanupGraces, [1_000]);
  assertEquals(log.includes("registry.drainAll(6000)"), true);
});

Deno.test("runShutdownDrain: the shutdown interruption carries the message that tells it from a user cancel", () => {
  assertEquals(
    new RunInterruption("server_shutdown").message,
    SHUTDOWN_ABORT_MESSAGE,
  );
});
