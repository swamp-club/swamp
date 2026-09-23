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
import fc from "fast-check";
import {
  collectWorkflowAuthoredExpressions,
  WorkflowExpressionEvaluator,
} from "./expression_evaluators.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import type { CelExpressionEvaluator } from "../expressions/cel_runtime.ts";

/** Evaluates every expression to the same marker, so what ran is visible. */
class MarkerEvaluator implements CelExpressionEvaluator {
  evaluate(): unknown {
    throw new Error("run-start evaluation is async");
  }
  evaluateAsync(): Promise<unknown> {
    return Promise.resolve("evaluated");
  }
}

/** Targets drawn from a small pool so identical text recurs across steps. */
const DATA_TARGETS = [
  "${{ data.latest('driver', 'next').?attributes.?name.orValue('a') }}",
  "${{ data.latest('driver', 'next').attributes.name }}",
];
const PLAIN_TARGET = "${{ inputs.name }}";

const arbStep = fc.record({
  kind: fc.constantFrom("workflow", "model"),
  guarded: fc.boolean(),
  target: fc.constantFrom(...DATA_TARGETS, PLAIN_TARGET),
});

Deno.test("WorkflowExpressionEvaluator: a deferred task target survives run-start evaluation verbatim", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(arbStep, { minLength: 1, maxLength: 5 }),
      fc.constantFrom(...DATA_TARGETS),
      async (specs, eagerText) => {
        const workflow = Workflow.create({
          name: "generated",
          // Evaluated eagerly at run start with the same text as some targets.
          description: eagerText,
          jobs: [Job.create({
            name: "job1",
            steps: specs.map((spec, index) =>
              Step.create({
                name: `step${index}`,
                guard: spec.guarded ? "${{ true }}" : undefined,
                task: spec.kind === "workflow"
                  ? StepTask.workflow(spec.target)
                  : StepTask.model(spec.target, "run"),
              })
            ),
          })],
        });

        const { workflow: evaluated } = await new WorkflowExpressionEvaluator(
          new MarkerEvaluator(),
        ).evaluate(
          workflow,
          { model: {}, env: {} },
          collectWorkflowAuthoredExpressions(workflow),
        );

        assertEquals(evaluated.description, "evaluated");
        evaluated.jobs[0].steps.forEach((step, index) => {
          const spec = specs[index];
          const data = step.task.data;
          const target = data.type === "workflow"
            ? data.workflowIdOrName
            : data.type === "model_method"
            ? data.modelIdOrName
            : undefined;
          const deferred = spec.guarded || spec.target !== PLAIN_TARGET;
          assertEquals(
            target,
            deferred ? spec.target : "evaluated",
            `${spec.kind} target, guarded=${spec.guarded}`,
          );
        });
      },
    ),
    { numRuns: 200 },
  );
});
