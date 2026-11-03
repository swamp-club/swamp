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
  | { readonly kind: "checkpoint" };

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

/** at any crash point, a step whose latest start no reset followed never recovers as pending */
Deno.test("WorkflowRun.interruptOrphaned: a journalled start never reads pending, at any crash point", () => {
  fc.assert(
    fc.property(
      fc.array(arbAction, { minLength: 1, maxLength: 30 }),
      (actions) => {
        let clock = Date.parse("2026-01-01T00:00:00.000Z");
        const iso = () => new Date(++clock).toISOString();
        const created = WorkflowRun.create(workflow());
        created.start();
        const live = structuredClone(created.toData()) as WorkflowRunData;
        let committed = structuredClone(live);
        const journal: StepStart[] = [];
        // a step's latest start, and whether a reset followed it
        const latest = new Map<string, { reset: boolean }>();
        let expansions = 0;

        for (const action of actions) {
          if (action.kind === "checkpoint") {
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
