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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AutoContinuationChecks,
  decideAutoContinuation,
  MAX_CONSECUTIVE_AUTO_CONTINUATIONS,
  refusalIsRetried,
} from "./auto_continuation.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { WorkflowRun } from "./workflow_run.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";

const GUARD = 'data.latest("m", "d") == null';

function workflowOf(
  opts: { guard?: string; autoContinue?: boolean; name?: string } = {},
): Workflow {
  return Workflow.create({
    id: "0b9c8d2e-5a0f-4c1e-9f3a-2b6d7e8f9a01",
    name: opts.name ?? "kept",
    autoContinue: opts.autoContinue,
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("m", "run"),
            guard: opts.guard,
          }),
          Step.create({ name: "step2", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
}

async function interrupted(
  workflow: Workflow,
  opts: { serve?: boolean; stamp?: boolean; atBoundary?: boolean } = {},
): Promise<WorkflowRun> {
  const run = WorkflowRun.create(workflow);
  const fingerprint = await computeWorkflowFingerprint(workflow);
  run.captureRunPlan(fingerprint, undefined, fingerprint);
  run.start(1, opts.serve === false ? undefined : "serve-a");
  run.jobs[0].start();
  run.jobs[0].steps[0].start();
  if (opts.atBoundary) run.jobs[0].steps[0].succeed();
  run.interrupt("server_crash");
  if (opts.stamp !== false) run.markContinuable(new Date());
  return run;
}

const SETTLED: AutoContinuationChecks = {
  fanOutPoolAvailable: true,
  nestedRunUnsettled: () => Promise.resolve(undefined),
};

Deno.test("decideAutoContinuation: a run stopped at a step boundary continues", async () => {
  const workflow = workflowOf();
  const run = await interrupted(workflow, { atBoundary: true });
  assertEquals(await decideAutoContinuation(workflow, run, SETTLED), {
    kind: "continue",
    resetSteps: [],
  });
});

Deno.test("decideAutoContinuation: a guarded step cut off continues and is reset", async () => {
  const workflow = workflowOf({ guard: GUARD });
  const run = await interrupted(workflow);
  assertEquals(await decideAutoContinuation(workflow, run, SETTLED), {
    kind: "continue",
    resetSteps: ["step1"],
  });
});

Deno.test("decideAutoContinuation: an unguarded step cut off is refused and named", async () => {
  const workflow = workflowOf();
  const run = await interrupted(workflow);
  const verdict = await decideAutoContinuation(workflow, run, SETTLED);
  if (verdict.kind !== "refuse") throw new Error(verdict.kind);
  assertEquals(verdict.refusal.reason, "unguarded_step");
  assertEquals(verdict.refusal.steps, ["step1"]);
  assertStringIncludes(verdict.refusal.message, "step1");
  assertStringIncludes(
    verdict.refusal.message,
    `swamp workflow recover kept --run ${run.id}`,
  );
});

Deno.test("decideAutoContinuation: a run serve never stamped is ineligible", async () => {
  const workflow = workflowOf({ guard: GUARD });
  const run = await interrupted(workflow, { stamp: false });
  assertEquals(await decideAutoContinuation(workflow, run, SETTLED), {
    kind: "ineligible",
  });
});

Deno.test("decideAutoContinuation: each refusal names its reason", async () => {
  const guarded = workflowOf({ guard: GUARD });
  const cases: Array<
    [
      string,
      () => Promise<[Workflow | null, WorkflowRun]>,
      AutoContinuationChecks?,
    ]
  > = [
    ["workflow_missing", async () => [null, await interrupted(guarded)]],
    [
      "not_serve_driven",
      async () => {
        // only a record written elsewhere carries a stamp without an owner
        const { instanceId: _owner, ...data } = (await interrupted(guarded))
          .toData();
        return [guarded, WorkflowRun.fromData(data)];
      },
    ],
    [
      "opted_out",
      async () => {
        const workflow = workflowOf({ guard: GUARD, autoContinue: false });
        return [workflow, await interrupted(workflow)];
      },
    ],
    [
      "definition_changed",
      async () => [
        workflowOf({ guard: 'data.latest("m", "other") == null' }),
        await interrupted(guarded),
      ],
    ],
    [
      "nested_run_unsettled",
      async () => [guarded, await interrupted(guarded)],
      {
        fanOutPoolAvailable: true,
        nestedRunUnsettled: () => Promise.resolve("child run still running"),
      },
    ],
  ];
  for (const [reason, build, checks] of cases) {
    const [workflow, run] = await build();
    const verdict = await decideAutoContinuation(
      workflow,
      run,
      checks ?? SETTLED,
    );
    if (verdict.kind !== "refuse") {
      throw new Error(`${reason}: ${verdict.kind}`);
    }
    assertEquals(verdict.refusal.reason, reason);
  }
});

Deno.test("decideAutoContinuation: continued too often in a row is refused naming the step", async () => {
  const workflow = workflowOf({ guard: GUARD });
  const run = await interrupted(workflow);
  let at = Date.parse("2026-11-12T10:00:00.000Z");
  for (let i = 0; i < MAX_CONSECUTIVE_AUTO_CONTINUATIONS; i++) {
    assertEquals(
      (await decideAutoContinuation(workflow, run, SETTLED)).kind,
      "continue",
    );
    run.resetUnknownStepsForRecovery({ holder: "serve-a", at: new Date(at) });
    run.resumeFromSuspended({ pid: 1, instanceId: "serve-a" });
    run.jobs[0].start();
    run.jobs[0].steps[0].start(new Date(at + 1000));
    run.interrupt("server_crash");
    run.markContinuable(new Date(at + 2000));
    at += 60_000;
  }
  const verdict = await decideAutoContinuation(workflow, run, SETTLED);
  if (verdict.kind !== "refuse") throw new Error(verdict.kind);
  assertEquals(verdict.refusal.reason, "continued_too_often");
  assertEquals(verdict.refusal.steps, ["step1"]);
});

Deno.test("decideAutoContinuation: a refusal stands for its interruption once the cause is lifted", async () => {
  const optedOut = workflowOf({ guard: GUARD, autoContinue: false });
  const run = await interrupted(optedOut);
  const first = await decideAutoContinuation(optedOut, run, SETTLED);
  if (first.kind !== "refuse") throw new Error(first.kind);
  run.recordAutoContinuationRefusal(first.refusal, new Date());

  const optedIn = workflowOf({ guard: GUARD });
  assertEquals(await decideAutoContinuation(optedIn, run, SETTLED), {
    kind: "ineligible",
  });
  // a later interruption is judged afresh
  run.markContinuable(new Date(Date.now() + 60_000));
  assertEquals(
    (await decideAutoContinuation(optedIn, run, SETTLED)).kind,
    "continue",
  );
});

Deno.test("decideAutoContinuation: a run refused for an unsettled nested run continues once it settles", async () => {
  const workflow = workflowOf({ guard: GUARD });
  const run = await interrupted(workflow);
  const first = await decideAutoContinuation(workflow, run, {
    fanOutPoolAvailable: true,
    nestedRunUnsettled: () => Promise.resolve("child still running"),
  });
  if (first.kind !== "refuse") throw new Error(first.kind);
  run.recordAutoContinuationRefusal(first.refusal, new Date());

  assertEquals(
    (await decideAutoContinuation(workflow, run, SETTLED)).kind,
    "continue",
  );
});

Deno.test("refusalIsRetried: only a nested run that settles on its own is judged again", () => {
  assertEquals(refusalIsRetried("nested_run_unsettled"), true);
  for (
    const reason of [
      "opted_out",
      "unguarded_step",
      "definition_changed",
      "launch_refused",
      "continued_too_often",
    ]
  ) {
    assertEquals(refusalIsRetried(reason), false, reason);
  }
});
