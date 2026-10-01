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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  CANCEL_SUSPENDED_NOT_FOUND,
  CANCEL_SUSPENDED_NOT_SUSPENDED,
  type CancelTargetWorkflow,
  locateSuspendedRunToCancel,
  workflowCancelSuspended,
  type WorkflowCancelSuspendedDeps,
  type WorkflowCancelSuspendedEvent,
  type WorkflowCancelSuspendedInput,
} from "./cancel_suspended.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import { StepTask } from "../../domain/workflows/step_task.ts";
import type { ActiveRunStatus } from "../../domain/models/active_run.ts";

function makeWorkflow(name: string): Workflow {
  return Workflow.create({
    name,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Approve"),
          }),
        ],
      }),
    ],
  });
}

function suspendedServeRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start(Deno.pid, crypto.randomUUID());
  const step = run.getJob("main")!.getStep("gate")!;
  run.getJob("main")!.start();
  step.start();
  step.waitForApproval();
  run.suspend();
  return run;
}

interface Harness {
  deps: WorkflowCancelSuspendedDeps;
  /** Every run and workflow repository call, as `repo.method`. */
  calls: string[];
  saved: WorkflowRun[];
  authorized: CancelTargetWorkflow[];
  tracked: { runId: string; status: ActiveRunStatus; reason?: string }[];
}

function harness(
  workflows: Workflow[],
  runs: WorkflowRun[],
  allow: (wf: CancelTargetWorkflow) => boolean = () => true,
): Harness {
  const calls: string[] = [];
  const saved: WorkflowRun[] = [];
  const authorized: CancelTargetWorkflow[] = [];
  const tracked: Harness["tracked"] = [];
  const deps: WorkflowCancelSuspendedDeps = {
    workflowRepo: {
      findByName: (name: string) => {
        calls.push("workflowRepo.findByName");
        return Promise.resolve(workflows.find((w) => w.name === name) ?? null);
      },
      findById: (id: string) => {
        calls.push("workflowRepo.findById");
        return Promise.resolve(workflows.find((w) => w.id === id) ?? null);
      },
      findAll: () => {
        calls.push("workflowRepo.findAll");
        return Promise.resolve(workflows);
      },
    } as unknown as WorkflowCancelSuspendedDeps["workflowRepo"],
    runRepo: {
      findById: (workflowId: string, runId: string) => {
        calls.push("runRepo.findById");
        return Promise.resolve(
          runs.find((r) => r.workflowId === workflowId && r.id === runId) ??
            null,
        );
      },
      findGlobalById: (runId: string) => {
        calls.push("runRepo.findGlobalById");
        const run = runs.find((r) => r.id === runId);
        return Promise.resolve(
          run ? { run, workflowId: run.workflowId } : null,
        );
      },
      save: (_workflowId: string, run: WorkflowRun) => {
        calls.push("runRepo.save");
        saved.push(run);
        return Promise.resolve();
      },
    } as unknown as WorkflowCancelSuspendedDeps["runRepo"],
    runTracker: {
      complete: (runId: string, status: ActiveRunStatus, reason?: string) => {
        tracked.push({ runId, status, reason });
      },
    } as unknown as WorkflowCancelSuspendedDeps["runTracker"],
    authorize: (wf) => {
      authorized.push(wf);
      return allow(wf);
    },
    findEvaluatedWorkflow: () => Promise.resolve(null),
  };
  return { deps, calls, saved, authorized, tracked };
}

async function cancel(
  deps: WorkflowCancelSuspendedDeps,
  input: WorkflowCancelSuspendedInput,
): Promise<WorkflowCancelSuspendedEvent | undefined> {
  const events = await collect(
    workflowCancelSuspended(createLibSwampContext(), deps, input),
  );
  return events.at(-1);
}

Deno.test("workflowCancelSuspended: cancels a suspended run found by id alone", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  const h = harness([wf], [run]);

  const last = await cancel(h.deps, { runId: run.id, reason: "stuck gate" });

  assertEquals(last?.kind, "completed");
  if (last?.kind === "completed") {
    assertEquals(last.data, {
      runId: run.id,
      workflowName: "deploy",
      previousStatus: "suspended",
      status: "cancelled",
    });
  }
  assertEquals(h.saved.length, 1);
  assertEquals(h.saved[0].status, "cancelled");
  assertEquals(h.saved[0].tags["cancel_reason"], "stuck gate");
  assertEquals(h.tracked, [{
    runId: run.id,
    status: "cancelled",
    reason: "stuck gate",
  }]);
});

Deno.test("workflowCancelSuspended: settles the waiting gate and its job", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  const h = harness([wf], [run]);

  await cancel(h.deps, { runId: run.id, reason: "stuck gate" });

  const job = h.saved[0].getJob("main")!;
  assertEquals(job.status, "failed");
  assertEquals(job.getStep("gate")!.status, "failed");
  assertEquals(job.getStep("gate")!.error, "cancelled");
  assertEquals(job.getStep("gate")!.settledByAbort, true);
});

Deno.test("workflowCancelSuspended: cancels a run found through its workflow", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  const h = harness([wf], [run]);

  const last = await cancel(h.deps, {
    runId: run.id,
    workflowIdOrName: "deploy",
    reason: "r",
  });

  assertEquals(last?.kind, "completed");
  assertEquals(h.saved[0].status, "cancelled");
});

Deno.test("workflowCancelSuspended: authorizes against the run's own workflow", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  const h = harness([wf], [run]);

  await cancel(h.deps, { runId: run.id, reason: "r" });

  assertEquals(h.authorized, [{ id: wf.id, name: "deploy" }]);
});

Deno.test("workflowCancelSuspended: denied, missing and mismatched runs get the same error", async () => {
  const deploy = makeWorkflow("deploy");
  const other = makeWorkflow("other");
  const run = suspendedServeRun(deploy);

  const denied = harness([deploy, other], [run], () => false);
  const deniedEvent = await cancel(denied.deps, { runId: run.id, reason: "r" });

  const missing = harness([deploy, other], [run]);
  const missingId = crypto.randomUUID();
  const missingEvent = await cancel(missing.deps, {
    runId: missingId,
    reason: "r",
  });

  const mismatched = harness([deploy, other], [run]);
  const mismatchedEvent = await cancel(mismatched.deps, {
    runId: run.id,
    workflowIdOrName: "other",
    reason: "r",
  });

  for (
    const [event, id] of [
      [deniedEvent, run.id],
      [missingEvent, missingId],
      [mismatchedEvent, run.id],
    ] as const
  ) {
    assertEquals(event?.kind, "error");
    if (event?.kind === "error") {
      assertEquals(event.error.code, CANCEL_SUSPENDED_NOT_FOUND);
      assertEquals(event.error.message, `No cancellable run with id ${id}`);
    }
  }
  assertEquals(denied.saved.length, 0);
  assertEquals(mismatched.saved.length, 0);
  assertEquals(mismatched.authorized, []);
});

Deno.test("workflowCancelSuspended: reveals a non-suspended status only after authorization", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  run.endAsCancelled("earlier");

  const allowed = harness([wf], [run]);
  const allowedEvent = await cancel(allowed.deps, {
    runId: run.id,
    workflowIdOrName: "deploy",
    reason: "r",
  });
  assertEquals(allowedEvent?.kind, "error");
  if (allowedEvent?.kind === "error") {
    assertEquals(allowedEvent.error.code, CANCEL_SUSPENDED_NOT_SUSPENDED);
    assertEquals(
      allowedEvent.error.message,
      `Run ${run.id} is not suspended (status: cancelled)`,
    );
  }
  assertEquals(allowed.saved.length, 0);

  const denied = harness([wf], [run], () => false);
  const deniedEvent = await cancel(denied.deps, {
    runId: run.id,
    workflowIdOrName: "deploy",
    reason: "r",
  });
  assertEquals(deniedEvent?.kind, "error");
  if (deniedEvent?.kind === "error") {
    assertEquals(deniedEvent.error.code, CANCEL_SUSPENDED_NOT_FOUND);
  }
});

Deno.test("workflowCancelSuspended: falls back to the run's workflow name when the workflow is gone", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  const h = harness([], [run]);

  const last = await cancel(h.deps, { runId: run.id, reason: "r" });

  assertEquals(last?.kind, "completed");
  assertEquals(h.authorized, [{ id: wf.id, name: "deploy" }]);
});

Deno.test("locateSuspendedRunToCancel: returns the run's workflow for an allowed caller", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  const h = harness([wf], [run]);

  const located = await locateSuspendedRunToCancel(h.deps, { runId: run.id });

  assertEquals(located, {
    workflowId: wf.id,
    workflow: { id: wf.id, name: "deploy" },
  });
  assertEquals(h.authorized, [{ id: wf.id, name: "deploy" }]);
  assertEquals(h.saved.length, 0);
  assertEquals(run.status, "suspended");
});

Deno.test("locateSuspendedRunToCancel: denied, missing and mismatched runs are all null", async () => {
  const deploy = makeWorkflow("deploy");
  const other = makeWorkflow("other");
  const run = suspendedServeRun(deploy);

  const denied = harness([deploy, other], [run], () => false);
  const missing = harness([deploy, other], [run]);
  const mismatched = harness([deploy, other], [run]);

  assertEquals(
    await locateSuspendedRunToCancel(denied.deps, { runId: run.id }),
    null,
  );
  assertEquals(
    await locateSuspendedRunToCancel(missing.deps, {
      runId: crypto.randomUUID(),
    }),
    null,
  );
  assertEquals(
    await locateSuspendedRunToCancel(mismatched.deps, {
      runId: run.id,
      workflowIdOrName: "other",
    }),
    null,
  );
  assertEquals(mismatched.authorized, []);
  for (const h of [denied, missing, mismatched]) {
    assertEquals(h.saved.length, 0);
  }
});

Deno.test("workflowCancelSuspended: loads a located run from its workflow alone", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  const h = harness([wf], [run]);
  h.deps.runRepo.findGlobalById = () => {
    throw new Error("a located run must not be searched for");
  };
  h.deps.workflowRepo.findByName = () => {
    throw new Error("a located run must not be looked up by name");
  };

  const last = await cancel(h.deps, {
    runId: run.id,
    workflowId: wf.id,
    reason: "r",
  });

  assertEquals(last?.kind, "completed");
  assertEquals(h.saved[0].status, "cancelled");
  assertEquals(h.authorized, [{ id: wf.id, name: "deploy" }]);
});

Deno.test("workflowCancelSuspended: a caller refused after the run was located gets not found", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  // Allowed when the run is located, refused on the cancel's own read, as
  // when a grant is revoked in between.
  let calls = 0;
  const h = harness([wf], [run], () => ++calls === 1);

  const located = await locateSuspendedRunToCancel(h.deps, { runId: run.id });
  assertEquals(located?.workflowId, wf.id);

  const last = await cancel(h.deps, {
    runId: run.id,
    workflowId: located!.workflowId,
    reason: "r",
  });

  assertEquals(last?.kind, "error");
  if (last?.kind === "error") {
    assertEquals(last.error.code, CANCEL_SUSPENDED_NOT_FOUND);
    assertEquals(last.error.message, `No cancellable run with id ${run.id}`);
  }
  assertEquals(calls, 2);
  assertEquals(h.saved.length, 0);
  assertEquals(run.status, "suspended");
});

Deno.test("workflowCancelSuspended: a run id that is not a UUID is not found without a repository read", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);

  for (const runId of ["-", "not-a-uuid", "../x", run.id.slice(0, 8)]) {
    for (const workflowIdOrName of [undefined, "deploy"]) {
      const h = harness([wf], [run]);

      const last = await cancel(h.deps, {
        runId,
        workflowIdOrName,
        reason: "r",
      });
      const located = await locateSuspendedRunToCancel(h.deps, {
        runId,
        workflowIdOrName,
      });

      assertEquals(last?.kind, "error");
      if (last?.kind === "error") {
        assertEquals(last.error.code, CANCEL_SUSPENDED_NOT_FOUND);
        assertEquals(last.error.message, `No cancellable run with id ${runId}`);
      }
      assertEquals(located, null);
      assertEquals(h.calls, []);
      assertEquals(h.authorized, []);
    }
  }
  assertEquals(run.status, "suspended");
});

Deno.test("locateSuspendedRunToCancel: finds a run by its own file, with or without a workflow", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);

  for (const workflowIdOrName of [undefined, "deploy", wf.id]) {
    const h = harness([wf], [run]);

    const located = await locateSuspendedRunToCancel(h.deps, {
      runId: run.id,
      workflowIdOrName,
    });

    assertEquals(located?.workflowId, wf.id);
    assertEquals(h.calls, [
      "runRepo.findGlobalById",
      "workflowRepo.findById",
    ]);
  }
});

Deno.test("locateSuspendedRunToCancel: an unknown run named with a workflow does no workflow lookup", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);

  for (const workflowIdOrName of ["deploy", "no-such-workflow"]) {
    const h = harness([wf], [run]);

    const located = await locateSuspendedRunToCancel(h.deps, {
      runId: crypto.randomUUID(),
      workflowIdOrName,
    });

    assertEquals(located, null);
    assertEquals(h.calls, ["runRepo.findGlobalById"]);
    assertEquals(h.authorized, []);
  }
});

Deno.test("locateSuspendedRunToCancel: a run that is not suspended is not found without a workflow", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);
  run.endAsCancelled("earlier");
  const h = harness([wf], [run]);

  assertEquals(
    await locateSuspendedRunToCancel(h.deps, { runId: run.id }),
    null,
  );
  assertEquals(h.authorized, []);
});

Deno.test("locateSuspendedRunToCancel: a run of a deleted workflow is matched and authorized by its recorded name", async () => {
  const wf = makeWorkflow("deploy");
  const run = suspendedServeRun(wf);

  const allowed = harness([], [run]);
  assertEquals(
    await locateSuspendedRunToCancel(allowed.deps, {
      runId: run.id,
      workflowIdOrName: "deploy",
    }),
    { workflowId: wf.id, workflow: { id: wf.id, name: "deploy" } },
  );
  assertEquals(allowed.authorized, [{ id: wf.id, name: "deploy" }]);

  const denied = harness([], [run], () => false);
  assertEquals(
    await locateSuspendedRunToCancel(denied.deps, {
      runId: run.id,
      workflowIdOrName: "deploy",
    }),
    null,
  );
  assertEquals(denied.authorized, [{ id: wf.id, name: "deploy" }]);

  const renamed = harness([], [run]);
  assertEquals(
    await locateSuspendedRunToCancel(renamed.deps, {
      runId: run.id,
      workflowIdOrName: "other",
    }),
    null,
  );
  assertEquals(renamed.authorized, []);
});
