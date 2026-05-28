// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DefinitionExpressionEvaluator,
  WorkflowExpressionEvaluator,
} from "./expression_evaluators.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { Definition } from "../definitions/definition.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import type { CelExpressionEvaluator } from "../expressions/cel_runtime.ts";
import type { ExpressionContext } from "../expressions/model_resolver.ts";

function emptyContext(): ExpressionContext {
  return { model: {}, env: {} };
}

// Stub evaluator that lets tests deterministically inject errors. The
// real CelEvaluator is used for normal cases; this stub is reserved
// for asserting strict-vs-lenient error handling.
class ThrowingEvaluator implements CelExpressionEvaluator {
  evaluate(): unknown {
    throw new Error("sync stub does not evaluate");
  }
  evaluateAsync(_expr: string): Promise<unknown> {
    return Promise.reject(new Error("forced eval failure"));
  }
}

// ---------------------------------------------------------------------------
// WorkflowExpressionEvaluator — strict
// ---------------------------------------------------------------------------

Deno.test("WorkflowExpressionEvaluator: returns workflow unchanged when no expressions", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "no-expr",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({ name: "s", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  const result = await evaluator.evaluate(workflow, emptyContext());
  assertEquals(result.expressionsEvaluated, 0);
  assertEquals(result.workflow.name, "no-expr");
});

Deno.test("WorkflowExpressionEvaluator: skips runtime expressions (vault/env)", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "runtime-expr",
    description: "${{ vault.get('v', 'k') }}",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({ name: "s", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  const result = await evaluator.evaluate(workflow, emptyContext());
  // Runtime expressions are not counted.
  assertEquals(result.expressionsEvaluated, 0);
  // And remain raw on the returned workflow.
  assertStringIncludes(
    result.workflow.description ?? "",
    "vault.get",
  );
});

Deno.test("WorkflowExpressionEvaluator: skips self.* (forEach variables resolved at runtime)", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "self-expr",
    description: "Run for ${{ self.env }}",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({ name: "s", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  const result = await evaluator.evaluate(workflow, emptyContext());
  assertEquals(result.expressionsEvaluated, 0);
  assertStringIncludes(result.workflow.description ?? "", "self.env");
});

Deno.test("WorkflowExpressionEvaluator: skips run.* (resolved at step execution time)", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "run-expr",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({
            name: "s",
            task: StepTask.model("m", "run", {
              resourceKey: "vms-${{ run.id }}",
              wfName: "${{ run.workflowName }}",
            }),
          }),
        ],
      }),
    ],
  });
  const result = await evaluator.evaluate(workflow, emptyContext());
  assertEquals(result.expressionsEvaluated, 0);
  const step = result.workflow.jobs[0].steps[0];
  const inputs = ("inputs" in step.task.data ? step.task.data.inputs : {}) ??
    {};
  assertEquals(inputs["resourceKey"], "vms-${{ run.id }}");
  assertEquals(inputs["wfName"], "${{ run.workflowName }}");
});

Deno.test("WorkflowExpressionEvaluator: skips bare workflowRunId (resolved at step execution time)", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "wfrunid-expr",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({
            name: "s",
            task: StepTask.model("m", "run", {
              runId: "${{ workflowRunId }}",
            }),
          }),
        ],
      }),
    ],
  });
  const result = await evaluator.evaluate(workflow, emptyContext());
  assertEquals(result.expressionsEvaluated, 0);
  const step = result.workflow.jobs[0].steps[0];
  const inputs = ("inputs" in step.task.data ? step.task.data.inputs : {}) ??
    {};
  assertEquals(inputs["runId"], "${{ workflowRunId }}");
});

Deno.test("WorkflowExpressionEvaluator: skips forEach.in expressions (must remain string for expansion)", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "foreach-expr",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({
            name: "s-${{ self.env }}",
            forEach: { item: "env", in: "${{ ['dev', 'prod'] }}" },
            task: StepTask.model("m", "run"),
          }),
        ],
      }),
    ],
  });
  const result = await evaluator.evaluate(workflow, emptyContext());
  // forEach.in is skipped; self.* in the step name is also skipped.
  assertEquals(result.expressionsEvaluated, 0);
  // And the forEach.in remains as a raw string for forEach expansion later.
  const step = result.workflow.jobs[0].steps[0];
  assertEquals(step.forEach?.in, "${{ ['dev', 'prod'] }}");
});

Deno.test("WorkflowExpressionEvaluator: skips task.inputs that depend on step outputs", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "step-output-dep",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({
            name: "produce",
            task: StepTask.model("vpc", "create"),
          }),
          Step.create({
            name: "consume",
            task: StepTask.model("subnet", "create", {
              vpc_id: "${{ model.vpc.resource.vpc.attributes.vpc_id }}",
            }),
          }),
        ],
      }),
    ],
  });
  // Empty model context — would cause an error if evaluated, but the
  // skip rule prevents that.
  const result = await evaluator.evaluate(workflow, emptyContext());
  assertEquals(result.expressionsEvaluated, 0);
});

Deno.test("WorkflowExpressionEvaluator: STRICT — per-expression eval error propagates", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new ThrowingEvaluator());
  const workflow = Workflow.create({
    name: "boom",
    description: "${{ inputs.thing }}",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({ name: "s", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
  await assertRejects(
    () => evaluator.evaluate(workflow, emptyContext()),
    Error,
    "forced eval failure",
  );
});

// ---------------------------------------------------------------------------
// DefinitionExpressionEvaluator — lenient
// ---------------------------------------------------------------------------

Deno.test("DefinitionExpressionEvaluator: returns definition unchanged when no expressions", async () => {
  const evaluator = new DefinitionExpressionEvaluator(new CelEvaluator());
  const def = Definition.create({
    name: "no-expr",
    methods: { run: { arguments: { hello: "world" } } },
  });
  const result = await evaluator.evaluate(def, emptyContext());
  assertEquals(result.name, "no-expr");
  assertEquals(result.getMethodArguments("run"), { hello: "world" });
});

Deno.test("DefinitionExpressionEvaluator: skips runtime expressions (vault/env)", async () => {
  const evaluator = new DefinitionExpressionEvaluator(new CelEvaluator());
  const def = Definition.create({
    name: "vault-leaf",
    methods: {
      run: {
        arguments: { token: "${{ vault.get('v', 'tok') }}" },
      },
    },
  });
  const result = await evaluator.evaluate(def, emptyContext());
  // Vault remains raw — resolved at runtime by the executor.
  assertEquals(
    result.getMethodArguments("run"),
    { token: "${{ vault.get('v', 'tok') }}" },
  );
});

Deno.test("DefinitionExpressionEvaluator: LENIENT — per-expression eval error is swallowed", async () => {
  const evaluator = new DefinitionExpressionEvaluator(new ThrowingEvaluator());
  const def = Definition.create({
    name: "lenient",
    methods: {
      run: { arguments: { thing: "${{ inputs.thing }}" } },
    },
  });
  // No throw despite the evaluator rejecting every async call.
  const result = await evaluator.evaluate(def, emptyContext());
  // The expression is left raw — the Proxy on globalArgs surfaces an
  // error later if the unresolved value is actually needed.
  assertEquals(
    result.getMethodArguments("run"),
    { thing: "${{ inputs.thing }}" },
  );
});

Deno.test("DefinitionExpressionEvaluator: skips expressions referencing missing model resource data", async () => {
  // Without a populated model context, `model.foo.resource.bar.X` is
  // missing-model-dep. Lenient skip; expression stays raw rather than
  // forcing the executor to crash.
  const evaluator = new DefinitionExpressionEvaluator(new CelEvaluator());
  const def = Definition.create({
    name: "missing-dep",
    methods: {
      run: {
        arguments: {
          vpc_id: "${{ model.foo.resource.bar.attributes.vpc_id }}",
        },
      },
    },
  });
  const result = await evaluator.evaluate(def, emptyContext());
  assertEquals(
    result.getMethodArguments("run"),
    { vpc_id: "${{ model.foo.resource.bar.attributes.vpc_id }}" },
  );
});
