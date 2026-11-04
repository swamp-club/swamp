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
import { StepStart } from "./step_start.ts";
import { StepTask } from "./step_task.ts";
import { Workflow } from "./workflow.ts";
import { WorkflowRun, type WorkflowRunData } from "./workflow_run.ts";

const arbName = fc.string({ minLength: 1, maxLength: 12 });

Deno.test("StepStart: round-trips and keeps its file name across random starts", () => {
  fc.assert(
    fc.property(
      fc.uuid(),
      fc.uuid(),
      arbName,
      arbName,
      fc.nat({ max: 4_000_000_000_000 }),
      (workflowId, runId, jobName, stepName, startedAt) => {
        const start = StepStart.create({
          workflowId,
          runId,
          jobName,
          stepName,
          startedAt,
        });
        const read = StepStart.fromYaml(start.toYaml());
        assert(read.equals(start));
        assertEquals(read.fileName, start.fileName);
      },
    ),
  );
});

Deno.test("StepStart: equal starts share a file name and differing ones do not", () => {
  fc.assert(
    fc.property(
      arbName,
      arbName,
      arbName,
      arbName,
      fc.nat({ max: 10 }),
      fc.nat({ max: 10 }),
      (jobA, stepA, jobB, stepB, atA, atB) => {
        const base = { workflowId: "w", runId: "r" };
        const a = StepStart.create({
          ...base,
          jobName: jobA,
          stepName: stepA,
          startedAt: atA,
        });
        const b = StepStart.create({
          ...base,
          jobName: jobB,
          stepName: stepB,
          startedAt: atB,
        });
        const same = jobA === jobB && stepA === stepB && atA === atB;
        assertEquals(a.fileName === b.fileName, same);
      },
    ),
  );
});

type Action =
  | { readonly kind: "step"; readonly job: number; readonly outcome: Outcome }
  | { readonly kind: "expand"; readonly job: number }
  | { readonly kind: "reset"; readonly job: number; readonly step: number }
  | { readonly kind: "checkpoint" }
  | { readonly kind: "resume" };

type Outcome = "succeed" | "fail" | "crash-mid-step";

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  fc.record({
    kind: fc.constant("step" as const),
    job: fc.nat({ max: 1 }),
    outcome: fc.constantFrom<Outcome>("succeed", "fail", "crash-mid-step"),
  }),
  fc.record({ kind: fc.constant("expand" as const), job: fc.nat({ max: 1 }) }),
  fc.record({
    kind: fc.constant("reset" as const),
    job: fc.nat({ max: 1 }),
    step: fc.nat({ max: 5 }),
  }),
  fc.record({ kind: fc.constant("checkpoint" as const) }),
  fc.record({ kind: fc.constant("resume" as const) }),
);

function workflow(): Workflow {
  return Workflow.create({
    name: "journal-prop",
    jobs: [0, 1].map((j) =>
      Job.create({
        name: `j${j}`,
        steps: [0, 1, 2].map((i) =>
          Step.create({ name: `s${i}`, task: StepTask.model("m", "run") })
        ),
      })
    ),
  });
}

interface Simulated {
  readonly committed: WorkflowRunData;
  readonly live: WorkflowRunData;
  readonly journal: StepStart[];
  /** a step's latest start, whether a reset followed it, and whether a resume did */
  readonly latest: Map<string, { reset: boolean; resumed?: boolean }>;
}

/** runs the actions as an owner would, committing the record only at checkpoints */
function simulate(actions: readonly Action[]): Simulated {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = () => new Date(++clock).toISOString();
  const created = WorkflowRun.create(workflow());
  created.start();
  const live = structuredClone(created.toData()) as WorkflowRunData;
  let committed = structuredClone(live);
  const journal: StepStart[] = [];
  const latest: Simulated["latest"] = new Map();
  let expansions = 0;

  for (const action of actions) {
    if (action.kind === "checkpoint") {
      committed = structuredClone(live);
      continue;
    }
    if (action.kind === "resume") {
      // resume resets the settled work and commits the record at once
      for (const job of live.jobs) {
        job.status = "pending";
        delete job.startedAt;
        for (const step of job.steps) {
          step.status = "pending";
          delete step.startedAt;
          delete step.completedAt;
          const key = JSON.stringify([job.jobName, step.stepName]);
          if (latest.has(key)) latest.set(key, { reset: true, resumed: true });
        }
      }
      live.resumedAt = iso();
      committed = structuredClone(live);
      continue;
    }
    const job = live.jobs[action.job];
    if (action.kind === "expand") {
      job.steps.push(
        {
          stepName: `s0[${expansions++}]`,
          status: "pending",
        } as typeof job.steps[number],
      );
      continue;
    }
    if (action.kind === "reset") {
      const step = job.steps[action.step % job.steps.length];
      if (step.status === "running") continue;
      step.status = "pending";
      delete step.startedAt;
      delete step.completedAt;
      const key = JSON.stringify([job.jobName, step.stepName]);
      if (latest.has(key)) latest.set(key, { reset: true });
      continue;
    }
    const step = job.steps.find((s) => s.status === "pending");
    if (step === undefined) continue;
    job.status = "running";
    step.status = "running";
    step.startedAt = iso();
    journal.push(StepStart.create({
      workflowId: live.workflowId,
      runId: live.id,
      jobName: job.jobName,
      stepName: step.stepName,
      startedAt: Date.parse(step.startedAt),
    }));
    latest.set(JSON.stringify([job.jobName, step.stepName]), {
      reset: false,
    });
    if (action.outcome === "crash-mid-step") break;
    step.status = action.outcome === "succeed" ? "succeeded" : "failed";
    step.completedAt = iso();
  }

  return { committed, live, journal, latest };
}

/** at any crash point, a step whose latest start no reset followed never recovers as pending */
Deno.test("WorkflowRun.interruptOrphaned: a journalled start never reads pending, at any crash point", () => {
  fc.assert(
    fc.property(
      fc.array(arbAction, { minLength: 1, maxLength: 30 }),
      (actions) => {
        const { committed, journal, latest } = simulate(actions);
        const recovered = WorkflowRun.fromData(committed);
        recovered.interruptOrphaned("owner_process_dead", journal);
        for (const [key, { reset }] of latest) {
          if (reset) continue;
          const [jobName, stepName] = JSON.parse(key) as [string, string];
          const step = recovered.getJob(jobName)?.getStep(stepName);
          assert(
            step !== undefined && step.status !== "pending",
            `${jobName}/${stepName} started but recovers as ${step?.status}`,
          );
        }
        // what workflow recover would ask about, read before the interrupt,
        // names every step the interrupt marks unknown
        const predicted = new Set(
          WorkflowRun.fromData(committed).unknownStepsIfOrphaned(journal),
        );
        for (const job of recovered.jobs) {
          for (const step of job.steps) {
            if (step.status === "unknown") {
              assert(
                predicted.has(step.stepName),
                `${step.stepName} is unknown but was not predicted`,
              );
            }
          }
        }
      },
    ),
    { numRuns: 500 },
  );
});

/** what a reader shows matches the owner's own record, without touching what the record already settled */
Deno.test("WorkflowRun.applyStepStarts: a step in flight at the crash reads running, settled steps are left, and applying twice changes nothing", () => {
  fc.assert(
    fc.property(
      fc.array(arbAction, { minLength: 1, maxLength: 30 }),
      (actions) => {
        const { committed, live, journal, latest } = simulate(actions);
        const viewed = WorkflowRun.fromData(structuredClone(committed));
        viewed.applyStepStarts(journal);

        for (const job of live.jobs) {
          for (const step of job.steps) {
            if (step.status !== "running") continue;
            const shown = viewed.getJob(job.jobName)?.getStep(step.stepName);
            assertEquals(shown?.status, "running");
            assertEquals(shown?.startedAt?.toISOString(), step.startedAt);
            assertEquals(viewed.getJob(job.jobName)?.status, "running");
          }
        }
        for (const [key, { reset, resumed }] of latest) {
          const [jobName, stepName] = JSON.parse(key) as [string, string];
          const step = viewed.getJob(jobName)?.getStep(stepName);
          if (resumed) {
            const recorded = committed.jobs
              .find((job) => job.jobName === jobName)?.steps
              .find((s) => s.stepName === stepName);
            assertEquals(
              step?.status,
              recorded?.status,
              `${jobName}/${stepName} reset by a resume reads its old start`,
            );
            continue;
          }
          if (reset) continue;
          assert(
            step !== undefined && step.status !== "pending",
            `${jobName}/${stepName} started but reads ${step?.status}`,
          );
        }

        const newest = new Map<string, number>();
        for (const start of journal) {
          const key = JSON.stringify([start.jobName, start.stepName]);
          newest.set(key, Math.max(newest.get(key) ?? 0, start.startedAt));
        }
        for (const job of committed.jobs) {
          for (const step of job.steps) {
            const started = newest.get(
              JSON.stringify([job.jobName, step.stepName]),
            );
            const held = step.startedAt ? Date.parse(step.startedAt) : -1;
            if (
              step.status === "pending" ||
              (started !== undefined && held < started)
            ) {
              continue;
            }
            const shown = viewed.getJob(job.jobName)?.getStep(step.stepName);
            assertEquals(shown?.status, step.status);
            assertEquals(shown?.startedAt?.toISOString(), step.startedAt);
          }
        }

        const again = WorkflowRun.fromData(
          structuredClone(viewed.toData()) as WorkflowRunData,
        );
        again.applyStepStarts(journal);
        assertEquals(again.toData(), viewed.toData());

        // a reader that saves what it showed, as cancel does, keeps recovery whole
        viewed.interruptOrphaned("owner_process_dead", journal);
        for (const [key, { reset }] of latest) {
          if (reset) continue;
          const [jobName, stepName] = JSON.parse(key) as [string, string];
          assert(
            viewed.getJob(jobName)?.getStep(stepName)?.status !== "pending",
            `${jobName}/${stepName} recovers as pending after a reader's save`,
          );
        }
      },
    ),
    { numRuns: 500 },
  );
});
