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
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";
import type { WorkflowId } from "../domain/workflows/workflow_id.ts";
import type { ActiveRun } from "./active_run_registry.ts";
import { createSyncGate } from "./sync_gate.ts";
import {
  interruptShutdownRuns,
  type ShutdownInterruptDeps,
} from "./shutdown_interrupt.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";

await initializeLogging({});

function workflow(): Workflow {
  return Workflow.create({
    name: `wf-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "sleep",
            task: StepTask.manualApproval("ok?"),
          }),
        ],
      }),
    ],
  });
}

function runningRun(wf: Workflow): WorkflowRun {
  const run = WorkflowRun.create(wf);
  run.start();
  return run;
}

function active(
  run: WorkflowRun,
  kind: ActiveRun["kind"] = "workflow-run",
): Pick<ActiveRun, "runId" | "kind" | "startedAt"> {
  return { runId: run.id, kind, startedAt: new Date() };
}

/**
 * A run repository and sync service that record, in order, each save (with
 * the status it saved) and each push.
 */
function harness(runs: WorkflowRun[], workflowId: WorkflowId) {
  const events: string[] = [];
  const repoContext: ShutdownInterruptDeps["repoContext"] = {
    markDirty: () => Promise.resolve(),
    workflowRunRepo: {
      findGlobalByStatus: (status) => {
        events.push("load");
        const wanted = Array.isArray(status) ? status : [status];
        return Promise.resolve(
          runs
            .filter((run) => wanted.includes(run.status))
            .map((run) => ({ run, workflowId })),
        );
      },
      save: (_wid, run) => {
        events.push(`save ${run.id} ${run.status}`);
        return Promise.resolve();
      },
    },
  };
  return { events, repoContext };
}

Deno.test("interruptShutdownRuns: saves a running run interrupted, then pushes it (swamp-club#3252)", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    syncService: {
      pushChanged: (options) => {
        events.push(`push ${options?.namespace}`);
        return Promise.resolve(1);
      },
    },
    namespace: "ns",
    syncGate: createSyncGate(),
  });

  assertEquals(result, { interrupted: [run.id] });
  assertEquals(events, ["load", `save ${run.id} interrupted`, "push ns"]);
  assertEquals(run.tags["interrupt_reason"], "server_shutdown");
});

Deno.test("interruptShutdownRuns: a run that ended cancelled is interrupted and pushed", async () => {
  // The run's own unit of work pushed `cancelled` before the interrupt ran,
  // as in the live reproduction.
  const wf = workflow();
  const run = runningRun(wf);
  run.endAsCancelled("server shutdown");
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([active(run, "workflow-resume")], {
    repoContext,
    syncService: {
      pushChanged: () => {
        events.push("push");
        return Promise.resolve(1);
      },
    },
  });

  assertEquals(result, { interrupted: [run.id] });
  assertEquals(events, ["load", `save ${run.id} interrupted`, "push"]);
});

Deno.test("interruptShutdownRuns: a run that completed during the drain is left alone", async () => {
  const wf = workflow();
  const done = runningRun(wf);
  done.complete();
  const status = done.status;
  const { events, repoContext } = harness([done], wf.id);

  const result = await interruptShutdownRuns([active(done)], {
    repoContext,
    syncService: {
      pushChanged: () => {
        events.push("push");
        return Promise.resolve(0);
      },
    },
  });

  assertEquals(result, { interrupted: [] });
  assertEquals(events, ["load"]);
  assertEquals(done.status, status);
});

Deno.test("interruptShutdownRuns: a failed push is reported, not thrown", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    syncService: {
      pushChanged: () => Promise.reject(new Error("S3 unreachable")),
    },
  });

  assertEquals(result, { interrupted: [run.id], pushError: "S3 unreachable" });
  assertEquals(events, ["load", `save ${run.id} interrupted`]);
});

Deno.test("interruptShutdownRuns: a push that never settles is cut off at the deadline and aborted", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { repoContext } = harness([run], wf.id);
  let signal: AbortSignal | undefined;

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    syncService: {
      pushChanged: (options) => {
        signal = options?.signal;
        // Settles only when aborted, as a push honouring the signal does.
        return new Promise((_, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal!.reason),
          )
        );
      },
    },
    pushTimeoutMs: 10,
  });

  assertEquals(result, {
    interrupted: [run.id],
    pushError: "timed out after 10ms",
  });
  assertEquals(signal?.aborted, true);
});

Deno.test("interruptShutdownRuns: a gate held by a pull is cut off at the deadline", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);
  const gate = createSyncGate();
  // A pull holds the gate exclusively for the whole shutdown.
  await gate.acquire();
  try {
    const result = await interruptShutdownRuns([active(run)], {
      repoContext,
      syncService: {
        pushChanged: () => {
          events.push("push");
          return Promise.resolve(1);
        },
      },
      syncGate: gate,
      pushTimeoutMs: 10,
    });

    assertEquals(result, {
      interrupted: [run.id],
      pushError: "timed out after 10ms",
    });
    assertEquals(events, ["load", `save ${run.id} interrupted`]);
  } finally {
    gate.release();
  }
  // The abandoned push queued for the gate ahead of this acquire, so once it
  // is granted the push has had its turn, and skipped it past the deadline.
  await gate.acquire();
  gate.release();
  assertEquals(events, ["load", `save ${run.id} interrupted`]);
});

Deno.test("interruptShutdownRuns: with no sync service the run is saved and nothing pushes", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);
  const reported: string[] = [];

  const result = await interruptShutdownRuns([active(run)], {
    repoContext,
    onInterrupted: (runId) => reported.push(runId),
  });

  assertEquals(result, { interrupted: [run.id] });
  assertEquals(events, ["load", `save ${run.id} interrupted`]);
  assertEquals(reported, [run.id]);
});

Deno.test("interruptShutdownRuns: no aborted workflow run loads nothing and pushes nothing", async () => {
  const wf = workflow();
  const run = runningRun(wf);
  const { events, repoContext } = harness([run], wf.id);

  const result = await interruptShutdownRuns(
    [{ runId: "m-1", kind: "method-run", startedAt: new Date() }],
    {
      repoContext,
      syncService: {
        pushChanged: () => {
          events.push("push");
          return Promise.resolve(0);
        },
      },
    },
  );

  assertEquals(result, { interrupted: [] });
  assertEquals(events, []);
});
