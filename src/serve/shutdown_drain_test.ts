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
import {
  type DrainableRunRegistry,
  type DrainableTriggerSource,
  runShutdownDrain,
} from "./shutdown_drain.ts";
import type { ActiveRun } from "./active_run_registry.ts";
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
  stop(): Promise<void> {
    this.log.push(`${this.name}.stop`);
    return Promise.resolve();
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
  // All three drains start before any of them settles.
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
  // A chained auto-resume can register after shutdown begins; the registry
  // must stop accepting runs although no drain waited (swamp-club#2736).
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
