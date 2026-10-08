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
  ContinuationSweepService,
  decideContinuationSweepStart,
  sweepContinuations,
} from "./continuation_sweep_service.ts";
import { ActiveRunRegistry } from "./active_run_registry.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import type { MergedServeOptions } from "./serve_config.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

function gatedWorkflow(name: string, autoResume: boolean): Workflow {
  return Workflow.create({
    name,
    autoResume,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "gate", task: StepTask.manualApproval("ok?") }),
        ],
      }),
    ],
  });
}

/** A run suspended on a gate, decided or not. */
function gatedRun(workflow: Workflow, decided: boolean): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const job = run.getJob("main")!;
  job.start();
  const gate = job.getStep("gate")!;
  gate.start();
  gate.waitForApproval();
  run.suspend();
  if (decided) gate.succeed();
  return run;
}

function harness(
  workflows: Workflow[],
  runs: WorkflowRun[],
  options: { failListingOf?: string } = {},
): { ctx: ConnectionContext; registry: ActiveRunRegistry; launched: string[] } {
  const launched: string[] = [];
  const registry = new class extends ActiveRunRegistry {
    override register(run: Parameters<ActiveRunRegistry["register"]>[0]) {
      super.register(run);
      launched.push(run.runId);
    }
  }();
  const ctx = {
    repoDir: "/nonexistent-swamp-repo",
    activeRunRegistry: registry,
    serveOptions: { autoResume: false } as MergedServeOptions,
    authConfig: { mode: "none" },
    repoContext: {
      workflowRepo: {
        findAll: () => Promise.resolve(workflows),
        findByName: (name: string) =>
          Promise.resolve(workflows.find((w) => w.name === name) ?? null),
        findById: (id: string) =>
          Promise.resolve(workflows.find((w) => w.id === id) ?? null),
      },
      workflowRunRepo: {
        findById: (_workflowId: string, runId: string) =>
          Promise.resolve(runs.find((r) => r.id === runId) ?? null),
        findAllByWorkflowId: () => Promise.resolve(runs),
        findSummariesByStatus: (workflowId: string, status: string) => {
          if (workflowId === options.failListingOf) {
            return Promise.reject(new Error("index unreadable"));
          }
          return Promise.resolve(
            runs
              .filter((r) => r.workflowId === workflowId && r.status === status)
              .map((r) => ({ id: r.id })),
          );
        },
      },
    },
  } as unknown as ConnectionContext;
  return { ctx, registry, launched };
}

async function settle(registry: ActiveRunRegistry, runIds: string[]) {
  for (const runId of runIds) await registry.get(runId)?.completion;
}

Deno.test("sweepContinuations: continues the settled runs whose policy allows, and counts what it looked at", async () => {
  const on = gatedWorkflow("on", true);
  const off = gatedWorkflow("off", false);
  const settled = gatedRun(on, true);
  const undecided = gatedRun(on, false);
  const policyOff = gatedRun(off, true);
  const { ctx, registry, launched } = harness([on, off], [
    settled,
    undecided,
    policyOff,
  ]);

  const result = await sweepContinuations(ctx, { takeover: true });

  assertEquals(result, { examined: 3, launched: 1 });
  assertEquals(launched, [settled.id]);
  await settle(registry, launched);
});

Deno.test("sweepContinuations: a workflow whose runs cannot be listed does not stop the pass", async () => {
  const broken = gatedWorkflow("broken", true);
  const fine = gatedWorkflow("fine", true);
  const run = gatedRun(fine, true);
  const { ctx, registry, launched } = harness(
    [broken, fine],
    [gatedRun(broken, true), run],
    { failListingOf: broken.id },
  );

  const result = await sweepContinuations(ctx, { takeover: true });

  assertEquals(result, { examined: 1, launched: 1 });
  assertEquals(launched, [run.id]);
  await settle(registry, launched);
});

Deno.test("sweepContinuations: stops between runs once the server is stopping", async () => {
  const workflow = gatedWorkflow("on", true);
  const { ctx, launched } = harness([workflow], [
    gatedRun(workflow, true),
    gatedRun(workflow, true),
  ]);

  const result = await sweepContinuations(ctx, {
    takeover: true,
    isStopping: () => true,
  });

  assertEquals(result, { examined: 0, launched: 0 });
  assertEquals(launched, []);
});

Deno.test("ContinuationSweepService: the first pass is the boot pass, and later ones are not", async () => {
  const passes: boolean[] = [];
  const service = new ContinuationSweepService({
    intervalMs: 3_600_000,
    sweep: ({ boot }) => {
      passes.push(boot);
      return Promise.resolve({ examined: 0, launched: 0 });
    },
  });
  try {
    service.start();
    // Waits for the boot pass in flight, then runs one of its own.
    await service.runOnce();
    await service.runOnce();
    assertEquals(passes, [true, false]);
  } finally {
    await service.dispose();
  }
});

Deno.test("ContinuationSweepService: a boot-pass-only sweep schedules no later pass", async () => {
  const counting = (bootPassOnly: boolean) => {
    const state = { passes: 0 };
    const service = new ContinuationSweepService({
      intervalMs: 1,
      bootPassOnly,
      sweep: () => {
        state.passes++;
        return Promise.resolve({ examined: 0, launched: 0 });
      },
    });
    return { state, service };
  };
  const once = counting(true);
  const repeating = counting(false);
  try {
    once.service.start();
    await waitFor(() => once.state.passes === 1, "the boot pass");
    // Started second with the same interval: by the time it has run three
    // passes, a second pass of the first sweep would have been due.
    repeating.service.start();
    await waitFor(() => repeating.state.passes >= 3, "the repeating sweep");
    assertEquals(once.state.passes, 1);
  } finally {
    await once.service.dispose();
    await repeating.service.dispose();
  }
});

Deno.test("ContinuationSweepService: a pass that fails is survived, and the next one still runs", async () => {
  let calls = 0;
  const service = new ContinuationSweepService({
    intervalMs: 3_600_000,
    sweep: () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("store unreachable"))
        : Promise.resolve({ examined: 0, launched: 0 });
    },
  });
  try {
    service.start();
    await service.runOnce();
    await service.runOnce();
    assertEquals(calls, 2);
  } finally {
    await service.dispose();
  }
});

Deno.test("ContinuationSweepService: dispose waits for the pass in flight and tells it to stop", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sawStopping = false;
  const service = new ContinuationSweepService({
    intervalMs: 3_600_000,
    sweep: async ({ isStopping }) => {
      await gate;
      sawStopping = isStopping();
      return { examined: 0, launched: 0 };
    },
  });
  const pass = service.runOnce();
  const disposed = service.dispose();
  release();
  await disposed;
  await pass;
  assertEquals(sawStopping, true);

  // Nothing starts after dispose.
  service.start();
});

Deno.test("ContinuationSweepService: start does not wait for the boot pass, and dispose does", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const service = new ContinuationSweepService({
    intervalMs: 3_600_000,
    sweep: async () => {
      await held;
      finished = true;
      return { examined: 0, launched: 0 };
    },
  });

  service.start();
  assertEquals(finished, false);
  const disposed = service.dispose();
  release();
  await disposed;
  assertEquals(finished, true);
});

Deno.test("decideContinuationSweepStart: a synced datastore needs claims every instance reads, and current run records", () => {
  const filesystem = {
    intervalMs: 30_000,
    syncedDatastore: false,
    sharedClaims: false,
    runRecordsCurrentAtBoot: true,
  };
  const synced = { ...filesystem, syncedDatastore: true, sharedClaims: true };

  assertEquals(decideContinuationSweepStart(filesystem), "start");
  assertEquals(decideContinuationSweepStart(synced), "start");
  assertEquals(
    decideContinuationSweepStart({ ...synced, intervalMs: 0 }),
    "disabled",
  );
  // No shared store, or one that cannot create a record atomically.
  assertEquals(
    decideContinuationSweepStart({ ...synced, sharedClaims: false }),
    "no_shared_claims",
  );
  assertEquals(
    decideContinuationSweepStart({ ...synced, runRecordsCurrentAtBoot: false }),
    "records_not_current",
  );
});
