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

import { assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  type LifecycleScheduler,
  ScheduledExecutionLifecycle,
  type ScheduledExecutionLifecycleDeps,
  type SchedulerBuildOptions,
} from "./scheduled_execution_lifecycle.ts";

class FakeScheduler implements LifecycleScheduler {
  readonly calls: string[] = [];
  readonly busy = new Set<string>();
  maxConcurrentRuns: number;
  #inFlight = Promise.withResolvers<void>();
  #hasRun = false;

  constructor(readonly options: SchedulerBuildOptions) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 1;
  }

  run(workflow: string): void {
    this.#hasRun = true;
    this.busy.add(workflow);
  }

  finish(): void {
    this.busy.clear();
    this.#inFlight.resolve();
  }

  drain(timeoutMs: number): Promise<void> {
    this.calls.push(`drain:${timeoutMs}`);
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.calls.push("stop");
    this.finish();
    return Promise.resolve();
  }

  startCatchUp(): void {
    this.calls.push("catchUp");
  }

  setMaxConcurrentRuns(maxConcurrentRuns: number): void {
    this.maxConcurrentRuns = maxConcurrentRuns;
  }

  admitQueued(): void {
    this.calls.push("admit");
  }

  holdsAny(identity: readonly string[]): boolean {
    return identity.some((key) => this.busy.has(key));
  }

  idle(): Promise<void> {
    return this.#hasRun ? this.#inFlight.promise : Promise.resolve();
  }
}

function harness(
  overrides: Partial<ScheduledExecutionLifecycleDeps<FakeScheduler>> = {},
  { booted = true }: { booted?: boolean } = {},
) {
  const built: FakeScheduler[] = [];
  const published: (FakeScheduler | null)[] = [];
  const replays: FakeScheduler[] = [];
  const cutoffs: string[] = [];
  let leads = true;
  const lifecycle = new ScheduledExecutionLifecycle<FakeScheduler>({
    build: (options) => {
      const service = new FakeScheduler(options);
      built.push(service);
      return service;
    },
    start: (service) => {
      service.calls.push("start");
      return Promise.resolve();
    },
    publish: (service) => published.push(service),
    leads: () => leads,
    replayOwnCron: (service, createdBefore) => {
      cutoffs.push(createdBefore);
      replays.push(service);
      service.calls.push("replay");
      return Promise.resolve(0);
    },
    maxConcurrentRuns: 2,
    ...overrides,
  });
  if (booted) lifecycle.markBootReplayed();
  return {
    lifecycle,
    built,
    published,
    replays,
    cutoffs,
    setLeads: (value: boolean) => leads = value,
  };
}

Deno.test("ScheduledExecutionLifecycle: turnOn builds, publishes, replays then catches up where it leads", async () => {
  const h = harness();
  const triggers = new Map([["nightly", { schedule: "0 3 * * *" }]]);
  await h.lifecycle.turnOn(triggers);
  assertEquals(h.built.length, 1);
  assertEquals(h.built[0].options.triggerOverrides, triggers);
  assertEquals(h.built[0].options.maxConcurrentRuns, 2);
  assertEquals(h.built[0].calls, ["start", "replay", "catchUp"]);
  assertEquals(h.published, [h.built[0]]);
  assertEquals(h.lifecycle.enabled(), true);
  assertEquals(h.lifecycle.ranScheduler(), true);
});

Deno.test("ScheduledExecutionLifecycle: a node that does not lead neither replays nor catches up", async () => {
  const h = harness();
  h.setLeads(false);
  await h.lifecycle.turnOn(undefined);
  assertEquals(h.built[0].calls, ["start"]);
  assertEquals(h.lifecycle.current(), h.built[0]);
});

Deno.test("ScheduledExecutionLifecycle: at boot startup replays and catches up itself", async () => {
  const h = harness();
  await h.lifecycle.turnOn(undefined, { atBoot: true });
  assertEquals(h.built[0].calls, ["start"]);
});

Deno.test("ScheduledExecutionLifecycle: a failed start publishes nothing, stops the half-started scheduler and rethrows", async () => {
  const h = harness({
    start: () => Promise.reject(new Error("scan failed")),
  });
  await assertRejects(
    () => h.lifecycle.turnOn(undefined),
    Error,
    "scan failed",
  );
  assertEquals(h.published, []);
  assertEquals(h.built[0].calls, ["stop"]);
  assertEquals(h.lifecycle.enabled(), false);
  assertEquals(h.lifecycle.ranScheduler(), false);
});

Deno.test("ScheduledExecutionLifecycle: a failed replay keeps the scheduler on and still catches up", async () => {
  const h = harness({
    replayOwnCron: () => Promise.reject(new Error("store down")),
  });
  await h.lifecycle.turnOn(undefined);
  assertEquals(h.lifecycle.current(), h.built[0]);
  assertEquals(h.built[0].calls, ["start", "catchUp"]);
});

Deno.test("ScheduledExecutionLifecycle: turnOff unpublishes and drains at once; runs in flight finish before it stops", async () => {
  const h = harness();
  await h.lifecycle.turnOn(undefined);
  const first = h.built[0];
  first.run("alpha");
  await h.lifecycle.turnOff();
  assertEquals(h.published, [first, null]);
  assertEquals(h.lifecycle.enabled(), false);
  assertEquals(h.lifecycle.ranScheduler(), true);
  assertEquals(first.calls.includes("drain:0"), true);
  assertEquals(first.calls.includes("stop"), false);
  assertEquals(h.lifecycle.retiring(), [first]);

  first.finish();
  await waitFor(() => h.lifecycle.retiring().length === 0, "retired");
  assertEquals(first.calls.at(-1), "stop");
});

Deno.test("ScheduledExecutionLifecycle: a scheduler turned on while another retires waits on its workflows and is admitted after", async () => {
  const h = harness();
  await h.lifecycle.turnOn(undefined);
  const first = h.built[0];
  first.run("alpha");
  await h.lifecycle.turnOff();
  await h.lifecycle.turnOn(undefined);
  const second = h.built[1];
  assertEquals(second.options.busyElsewhere(["alpha"]), true);
  assertEquals(second.options.busyElsewhere(["beta"]), false);

  first.finish();
  await waitFor(() => h.lifecycle.retiring().length === 0, "retired");
  assertEquals(second.options.busyElsewhere(["alpha"]), false);
  assertEquals(second.calls.includes("admit"), true);
});

Deno.test("ScheduledExecutionLifecycle: setMaxConcurrentRuns applies to the live scheduler and the next one built", async () => {
  const h = harness();
  await h.lifecycle.turnOn(undefined);
  h.lifecycle.setMaxConcurrentRuns(4);
  assertEquals(h.built[0].maxConcurrentRuns, 4);
  await h.lifecycle.turnOff();
  await h.lifecycle.turnOn(undefined);
  assertEquals(h.built[1].options.maxConcurrentRuns, 4);
});

Deno.test("ScheduledExecutionLifecycle: shutdown drains the live and retiring schedulers, a double drain included, then stops both", async () => {
  const h = harness();
  await h.lifecycle.turnOn(undefined);
  const first = h.built[0];
  first.run("alpha");
  await h.lifecycle.turnOff();
  await h.lifecycle.turnOn(undefined);
  const second = h.built[1];

  await h.lifecycle.drain(30_000);
  assertEquals(first.calls.filter((c) => c.startsWith("drain")), [
    "drain:0",
    "drain:30000",
  ]);
  assertEquals(second.calls.includes("drain:30000"), true);
  await h.lifecycle.stop();
  assertEquals(first.calls.filter((c) => c === "stop").length, 1);
  assertEquals(second.calls.at(-1), "stop");
  assertEquals(h.lifecycle.retiring(), []);
});

Deno.test("ScheduledExecutionLifecycle: a turnOn that resolves after shutdown began stops what it built and publishes nothing", async () => {
  const started = Promise.withResolvers<void>();
  const h = harness({
    start: () => started.promise,
  });
  const turning = h.lifecycle.turnOn(undefined);
  const draining = h.lifecycle.drain(0);
  started.resolve();
  await Promise.all([turning, draining]);
  assertEquals(h.published, []);
  assertEquals(h.built[0].calls, ["stop"]);

  await h.lifecycle.turnOn(undefined);
  assertEquals(h.built.length, 1);
});

Deno.test("ScheduledExecutionLifecycle: own-run replay takes only runs queued before the turn-on began", async () => {
  const h = harness();
  const before = new Date().toISOString();
  await h.lifecycle.turnOn(undefined);
  const after = new Date().toISOString();
  assertEquals(h.cutoffs.length, 1);
  assertEquals(h.cutoffs[0] >= before && h.cutoffs[0] <= after, true);
});

Deno.test("ScheduledExecutionLifecycle: a turn-on that did not lead replays at the lead, from its own cutoff", async () => {
  const h = harness();
  h.setLeads(false);
  await h.lifecycle.turnOn(undefined);
  assertEquals(h.built[0].calls, ["start"]);
  const cutoff = h.cutoffs.length;
  assertEquals(cutoff, 0);

  h.setLeads(true);
  await h.lifecycle.atLead();
  assertEquals(h.built[0].calls, ["start", "replay", "catchUp"]);
  assertEquals(h.cutoffs.length, 1);

  await h.lifecycle.atLead();
  assertEquals(h.built[0].calls, ["start", "replay", "catchUp", "catchUp"]);
});

Deno.test("ScheduledExecutionLifecycle: a scheduler that has led all along only catches up at the lead", async () => {
  const h = harness();
  await h.lifecycle.turnOn(undefined, { atBoot: true });
  await h.lifecycle.atLead();
  assertEquals(h.built[0].calls, ["start", "catchUp"]);
  assertEquals(h.replays, []);
});

Deno.test("ScheduledExecutionLifecycle: a retiring scheduler's run ending admits the live scheduler's queue", async () => {
  const h = harness();
  await h.lifecycle.turnOn(undefined);
  const first = h.built[0];
  first.run("alpha");
  first.run("beta");
  await h.lifecycle.turnOff();
  await h.lifecycle.turnOn(undefined);
  const second = h.built[1];
  const admitsBefore = second.calls.filter((c) => c === "admit").length;
  first.busy.delete("alpha");
  first.options.onRunSettled();
  assertEquals(
    second.calls.filter((c) => c === "admit").length,
    admitsBefore + 1,
  );
  assertEquals(h.lifecycle.retiring(), [first]);
});

Deno.test("ScheduledExecutionLifecycle: before the boot replay a reload can neither turn scheduling on nor off, and applies once it has run", async () => {
  const h = harness({}, { booted: false });
  await assertRejects(
    () => h.lifecycle.turnOn(undefined),
    Error,
    "serve is still starting",
  );
  assertEquals(h.built, []);
  assertEquals(h.published, []);

  await h.lifecycle.turnOn(undefined, { atBoot: true });
  const boot = h.built[0];
  await assertRejects(
    () => h.lifecycle.turnOff(),
    Error,
    "serve is still starting",
  );
  assertEquals(h.lifecycle.current(), boot);
  assertEquals(boot.calls, ["start"]);

  h.lifecycle.markBootReplayed();
  await h.lifecycle.turnOff();
  await h.lifecycle.turnOn(undefined);
  assertEquals(h.built.length, 2);
  assertEquals(h.built[1].calls, ["start", "replay", "catchUp"]);
});

async function settledWhenStartIsHeld(
  shutdown: (
    lifecycle: ScheduledExecutionLifecycle<FakeScheduler>,
  ) => Promise<void>,
  release: (started: PromiseWithResolvers<void>) => void,
): Promise<void> {
  const started = Promise.withResolvers<void>();
  const h = harness({ start: () => started.promise });
  const turning = h.lifecycle.turnOn(undefined).catch(() => {});
  await waitFor(() => h.built.length === 1, "the scheduler is built");
  let settled = false;
  const done = shutdown(h.lifecycle).then(() => settled = true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(settled, false);

  release(started);
  await done;
  assertEquals(h.built[0].calls, ["stop"]);
  assertEquals(h.published, []);
  await turning;
}

Deno.test("ScheduledExecutionLifecycle: shutdown waits for a scheduler a reload is still starting and stops it", async () => {
  await settledWhenStartIsHeld(
    (lifecycle) => lifecycle.drain(0),
    (started) => started.resolve(),
  );
  await settledWhenStartIsHeld(
    (lifecycle) => lifecycle.stop(),
    (started) => started.resolve(),
  );
  await settledWhenStartIsHeld(
    (lifecycle) => lifecycle.drain(0),
    (started) => started.reject(new Error("store closed")),
  );
});
