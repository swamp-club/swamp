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
import { configure, type LogRecord, reset } from "@logtape/logtape";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Fleet } from "./fleet_harness.ts";

await initializeLogging({});

const SANITIZE = { sanitizeOps: false, sanitizeResources: false };
const TASK = {
  type: "model_method" as const,
  modelIdOrName: "deploy",
  methodName: "run",
};
const WORKER_INPUT = (value: string) => ({
  properties: { worker: { type: "string", default: value } },
});
const WORKER = "${{ inputs.worker }}";

type WorkflowData = Parameters<Fleet["saveWorkflow"]>[0];

// a short queueTimeout, so an empty selector that queues fails the run
// instead of holding the test for the default ten minutes
async function runOn(
  fleet: Fleet,
  workflow: Omit<WorkflowData, "name" | "queueTimeout">,
): Promise<string> {
  await fleet.saveDefinition("deploy");
  await fleet.saveWorkflow({ name: "wf", queueTimeout: 2, ...workflow });
  const run = await fleet.runWorkflow("wf");
  return run.status;
}

function received(fleet: Fleet, worker: string): (string | undefined)[] {
  return fleet.worker(worker).received.map((d) => d.stepName);
}

Deno.test({
  name:
    "empty placement: a target whose input defaults to empty runs the step locally instead of queueing",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    const status = await runOn(fleet, {
      inputs: WORKER_INPUT(""),
      jobs: [{
        name: "main",
        target: WORKER,
        affinity: true,
        steps: [{ name: "collect", task: TASK }],
      }],
    });

    assertEquals(status, "succeeded");
    assertEquals(received(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "empty placement: the same target with a worker name dispatches to that worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    const status = await runOn(fleet, {
      inputs: WORKER_INPUT("w-a"),
      jobs: [{
        name: "main",
        target: WORKER,
        affinity: true,
        steps: [{ name: "collect", task: TASK }],
      }],
    });

    assertEquals(status, "succeeded");
    assertEquals(received(fleet, "w-a"), ["collect"]);
  },
});

Deno.test({
  name:
    "empty placement: a label whose input is empty is dropped, so its only label leaves the step local",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: { host: "w-a" } });
    const status = await runOn(fleet, {
      inputs: WORKER_INPUT(""),
      labels: { host: WORKER },
      jobs: [{ name: "main", steps: [{ name: "collect", task: TASK }] }],
    });

    assertEquals(status, "succeeded");
    assertEquals(received(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "empty placement: an empty label beside another drops only its own key, and the step is placed by the rest",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: { fleet: "web", host: "w-a" } });
    const status = await runOn(fleet, {
      inputs: WORKER_INPUT(""),
      labels: { fleet: "web", host: WORKER },
      jobs: [{ name: "main", steps: [{ name: "collect", task: TASK }] }],
    });

    assertEquals(status, "succeeded");
    assertEquals(received(fleet, "w-a"), ["collect"]);
  },
});

Deno.test({
  name:
    "empty placement: an empty platform runs the step locally instead of on any worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    const status = await runOn(fleet, {
      inputs: {},
      platform: "",
      jobs: [{ name: "main", steps: [{ name: "collect", task: TASK }] }],
    });

    assertEquals(status, "succeeded");
    assertEquals(received(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "empty placement: an empty target on a job clears the target the workflow set",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    const status = await runOn(fleet, {
      inputs: {},
      target: "w-a",
      jobs: [{
        name: "main",
        target: "",
        steps: [{ name: "collect", task: TASK }],
      }],
    });

    assertEquals(status, "succeeded");
    assertEquals(received(fleet, "w-a"), []);
  },
});

Deno.test({
  name:
    "empty placement: a forEach target resolved per item runs an empty item locally and the named one on its worker",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a");
    const status = await runOn(fleet, {
      inputs: {},
      jobs: [{
        name: "main",
        steps: [{
          name: "collect-${{ self.worker }}",
          forEach: { item: "worker", in: '${{ ["w-a", ""] }}' },
          target: "${{ self.worker }}",
          task: TASK,
        }],
      }],
    });

    assertEquals(status, "succeeded");
    assertEquals(received(fleet, "w-a"), ["collect-w-a"]);
  },
});

// the run logger is process-global, so the suite's logging is restored after
async function runLogLines(fn: () => Promise<void>): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      { category: ["model"], lowestLevel: "info", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) =>
    `${record.level}: ${record.message.map(String).join("")}`
  );
}

Deno.test({
  name:
    "empty placement: a run logs the field an empty value cleared and whether the step is left unplaced",
  ...SANITIZE,
  fn: async () => {
    await using fleet = await Fleet.start();
    await fleet.addWorker("w-a", { labels: { fleet: "web", host: "w-a" } });
    const lines = await runLogLines(async () => {
      assertEquals(
        await runOn(fleet, {
          inputs: WORKER_INPUT(""),
          jobs: [{
            name: "main",
            target: WORKER,
            steps: [{ name: "collect", task: TASK }],
          }],
        }),
        "succeeded",
      );
    });
    assertEquals(
      lines.filter((line) => line.includes(": Placement ")),
      ["warning: Placement target is empty, which clears it: the step has no placement"],
    );

    const widened = await runLogLines(async () => {
      await fleet.saveWorkflow({
        name: "wf2",
        inputs: WORKER_INPUT(""),
        queueTimeout: 2,
        labels: { fleet: "web", host: WORKER },
        jobs: [{ name: "main", steps: [{ name: "collect", task: TASK }] }],
      });
      assertEquals((await fleet.runWorkflow("wf2")).status, "succeeded");
    });
    assertEquals(
      widened.filter((line) => line.includes(": Placement ")),
      [
        "info: Placement labels.host is empty, which clears it: the step is placed by the fields that remain",
      ],
    );
  },
});
