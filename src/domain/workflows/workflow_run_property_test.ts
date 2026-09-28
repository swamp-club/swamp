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
import fc from "fast-check";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import {
  CANCELLED_STEP_ERROR,
  JobRun,
  type StepRun,
  type StepRunRef,
  WorkflowRun,
} from "./workflow_run.ts";

// Two jobs that share step names, since tracking is per record.
const JOBS = ["a", "b"];
const STEPS = ["x", "y", "z"];

const TRANSITIONS: ReadonlyArray<(step: StepRun) => void> = [
  (s) => s.start(),
  (s) => s.waitForApproval(),
  (s) => s.succeed(),
  (s) => s.fail("boom"),
  (s) => s.markUnknown(),
  (s) => s.skip({ kind: "dependency" }),
  (s) => s.resetToPending(),
];

function createFailedRun(): WorkflowRun {
  const run = WorkflowRun.create(
    Workflow.create({
      name: "marker-wf",
      jobs: JOBS.map((name) =>
        Job.create({
          name,
          steps: STEPS.map((step) =>
            Step.create({ name: step, task: StepTask.model("m", "run") })
          ),
        })
      ),
    }),
  );
  run.start();
  for (const job of run.jobs) {
    for (const step of job.steps) step.fail("boom");
    job.fail();
  }
  run.complete();
  return run;
}

const arbRef: fc.Arbitrary<StepRunRef> = fc.record({
  jobName: fc.constantFrom(...JOBS),
  stepName: fc.constantFrom(...STEPS),
});

const arbResume = fc.record({
  reset: fc.subarray(STEPS, { minLength: 1 }),
  tracked: fc.array(arbRef, { maxLength: 6 }),
});

const arbTransition = fc.record({
  ref: arbRef,
  transition: fc.nat({ max: TRANSITIONS.length - 1 }),
});

Deno.test("WorkflowRun: a reset marker only marks tracked reset records and never outlives pending", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          resume: arbResume,
          transitions: fc.array(arbTransition, { maxLength: 8 }),
        }),
        { minLength: 1, maxLength: 3 },
      ),
      (resumes) => {
        const run = createFailedRun();
        for (const { resume, transitions } of resumes) {
          const reset = new Set(resume.reset);
          const tracked = resume.tracked.filter((r) => reset.has(r.stepName));
          run.resetForResumeFrom(reset, tracked);

          for (const job of run.jobs) {
            for (const step of job.steps) {
              const isTracked = tracked.some((r) =>
                r.jobName === job.jobName && r.stepName === step.stepName
              );
              assertEquals(step.resetByResume, isTracked);
            }
          }

          for (const { ref, transition } of transitions) {
            TRANSITIONS[transition](
              run.getJob(ref.jobName)!.getStep(ref.stepName)!,
            );
          }
          for (const job of run.jobs) {
            for (const step of job.steps) {
              if (step.resetByResume) assertEquals(step.status, "pending");
            }
          }

          for (const job of run.jobs) {
            const stranded = job.failStrandedResetSteps();
            for (const step of stranded) {
              assertEquals(step.failureKind, "workflow_changed");
              assertEquals(step.allowedFailure, false);
            }
            assert(job.steps.every((s) => !s.resetByResume));
          }
        }
      },
    ),
  );
});

Deno.test("WorkflowRun: resetting a stranded step clears its failure kind", () => {
  fc.assert(
    fc.property(arbRef, (ref) => {
      const run = createFailedRun();
      run.resetForResumeFrom(new Set([ref.stepName]), [ref]);
      const job = run.getJob(ref.jobName)!;
      assertEquals(job.failStrandedResetSteps().length, 1);
      run.resetForResumeFrom(new Set([ref.stepName]));
      const step = job.getStep(ref.stepName)!;
      assertEquals(step.failureKind, undefined);
      assertEquals(step.status, "pending");
      assertEquals(step.resetByResume, false);
    }),
  );
});

Deno.test("JobRun: cancelling pending steps settles every named pending step and leaves the rest untouched", () => {
  fc.assert(
    fc.property(
      fc.array(fc.nat({ max: TRANSITIONS.length - 1 }), {
        minLength: STEPS.length,
        maxLength: STEPS.length,
      }),
      fc.subarray(STEPS),
      (transitions, names) => {
        const job = JobRun.pending("a", STEPS);
        STEPS.forEach((name, i) =>
          TRANSITIONS[transitions[i]](job.getStep(name)!)
        );
        const before = new Map(
          job.steps.map((s) => [s.stepName, s.toData()] as const),
        );

        const cancelled = job.cancelPendingSteps(names);

        for (const step of job.steps) {
          const was = before.get(step.stepName)!;
          if (names.includes(step.stepName) && was.status === "pending") {
            assertEquals(step.status, "failed");
            assertEquals(step.error, CANCELLED_STEP_ERROR);
            assertEquals(step.settledByAbort, true);
            assert(cancelled.includes(step));
          } else {
            assertEquals(step.toData(), was);
            assert(!cancelled.includes(step));
          }
        }
      },
    ),
  );
});

Deno.test("JobRun: settling a never-started job is decided by its steps and leaves a started job alone", () => {
  // A never-started job's steps are pending, cancelled (failed) or skipped.
  const SETTLED: ReadonlyArray<(step: StepRun) => void> = [
    () => {},
    (s) => s.fail(CANCELLED_STEP_ERROR),
    (s) => s.skip({ kind: "dependency" }),
  ];
  fc.assert(
    fc.property(
      fc.array(fc.nat({ max: SETTLED.length - 1 }), {
        minLength: STEPS.length,
        maxLength: STEPS.length,
      }),
      fc.boolean(),
      (outcomes, started) => {
        const job = JobRun.pending("a", STEPS);
        STEPS.forEach((name, i) => SETTLED[outcomes[i]](job.getStep(name)!));
        if (started) job.start();
        const before = job.toData();
        const statuses = job.steps.map((s) => s.status);

        job.settleNotStarted();

        if (started) {
          assertEquals(job.toData(), before);
        } else if (statuses.includes("pending")) {
          assertEquals(job.status, "pending");
        } else if (statuses.includes("failed")) {
          assertEquals(job.status, "failed");
        } else {
          assertEquals(job.status, "skipped");
        }
        // Steps are never changed by settling the job.
        assertEquals(job.steps.map((s) => s.status), statuses);
      },
    ),
  );
});

Deno.test("WorkflowRun: reopening aborted work resets exactly the settled records and reopens the finished jobs holding aborted work", () => {
  // Each step either took a transition, or was settled by the abort.
  const OUTCOMES: ReadonlyArray<(step: StepRun) => void> = [
    ...TRANSITIONS,
    (s) => s.cancelUnstarted(),
    (s) => s.skipUnstarted({ kind: "dependency" }),
  ];
  const JOB_STATUSES: ReadonlyArray<(job: JobRun) => void> = [
    () => {},
    (j) => j.start(),
    (j) => j.succeed(),
    (j) => j.fail(),
    (j) => j.skip(),
    (j) => j.markUnknown(),
  ];
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          status: fc.nat({ max: JOB_STATUSES.length - 1 }),
          steps: fc.array(fc.nat({ max: OUTCOMES.length - 1 }), {
            minLength: STEPS.length,
            maxLength: STEPS.length,
          }),
        }),
        { minLength: JOBS.length, maxLength: JOBS.length },
      ),
      (jobs) => {
        const run = createFailedRun();
        run.jobs.forEach((job, i) => {
          STEPS.forEach((name, j) => {
            const step = job.getStep(name)!;
            step.resetToPending();
            OUTCOMES[jobs[i].steps[j]](step);
          });
          job.resetToPending();
          JOB_STATUSES[jobs[i].status](job);
        });
        const before = run.jobs.map((job) => job.toData());

        run.reopenAbortedWork();

        run.jobs.forEach((job, i) => {
          const was = before[i];
          const settled = was.steps.some((s) => s.settledByAbort === true);
          // An undecided step the abort left in a job it ended unknown.
          const undecided = was.status === "unknown" &&
            was.steps.some((s) => s.status === "pending");
          job.steps.forEach((step, j) => {
            if (was.steps[j].settledByAbort) {
              assertEquals(step.status, "pending");
              assertEquals(step.settledByAbort, false);
            } else {
              assertEquals(step.toData(), was.steps[j]);
            }
          });
          const finished = ["succeeded", "failed", "skipped", "unknown"]
            .includes(was.status);
          assertEquals(
            job.status,
            (settled || undecided) && finished ? "pending" : was.status,
          );
        });
      },
    ),
  );
});
