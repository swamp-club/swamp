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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  collectWorkflowAuthoredExpressions,
  createTaskTargetDeferral,
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
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
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
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
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
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
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
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
  assertEquals(result.expressionsEvaluated, 0);
  const step = result.workflow.jobs[0].steps[0];
  const inputs =
    (("inputs" in step.task.data ? step.task.data.inputs : {}) ?? {}) as Record<
      string,
      unknown
    >;
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
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
  assertEquals(result.expressionsEvaluated, 0);
  const step = result.workflow.jobs[0].steps[0];
  const inputs =
    (("inputs" in step.task.data ? step.task.data.inputs : {}) ?? {}) as Record<
      string,
      unknown
    >;
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
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
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
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
  assertEquals(result.expressionsEvaluated, 0);
});

Deno.test("WorkflowExpressionEvaluator: skips assert task.message that depends on step outputs", async () => {
  const evaluator = new WorkflowExpressionEvaluator(new CelEvaluator());
  const workflow = Workflow.create({
    name: "assert-msg-deferred",
    jobs: [
      Job.create({
        name: "j",
        steps: [
          Step.create({
            name: "collect",
            task: StepTask.model("server", "run"),
          }),
          Step.create({
            name: "verify",
            task: StepTask.assert(
              'data.latest("server", "result").attributes.exitCode == 0',
              'Exit code was ${{ data.latest("server", "result").attributes.exitCode }}',
            ),
          }),
        ],
      }),
    ],
  });
  const result = await evaluator.evaluate(
    workflow,
    emptyContext(),
    "unrestricted",
  );
  assertEquals(result.expressionsEvaluated, 0);
  const assertStep = result.workflow.jobs[0].steps[1];
  const task = assertStep.task.data as { message: string };
  assertStringIncludes(task.message, "${{ data.latest");
});

Deno.test("WorkflowExpressionEvaluator: preserves raw assert CEL even when its literals also appear in messages", async () => {
  const predicate = 'size("${{ inputs.value }}") > 0';
  const workflow = Workflow.create({
    name: "assert-literals",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "verify",
        task: StepTask.assert(predicate, "Value: ${{ inputs.value }}"),
      })],
    })],
  });
  const result = await new WorkflowExpressionEvaluator(new CelEvaluator())
    .evaluate(
      workflow,
      { ...emptyContext(), inputs: { value: "resolved" } },
      "unrestricted",
    );
  assertEquals(result.workflow.jobs[0].steps[0].task.data, {
    type: "assert",
    expr: predicate,
    message: "Value: resolved",
    severity: "high",
  });
});

Deno.test("WorkflowExpressionEvaluator: does not evaluate interpolation inside raw assert CEL", async () => {
  const predicate = 'size("${{ missing.value }}") > 0';
  const workflow = Workflow.create({
    name: "assert-literal-only",
    jobs: [Job.create({
      name: "main",
      steps: [Step.create({
        name: "verify",
        task: StepTask.assert(predicate, "literal"),
      })],
    })],
  });
  const result = await new WorkflowExpressionEvaluator(new ThrowingEvaluator())
    .evaluate(workflow, emptyContext(), "unrestricted");
  assertEquals(result.expressionsEvaluated, 0);
  assertEquals(result.workflow.toData(), workflow.toData());
  assertEquals(
    collectWorkflowAuthoredExpressions(workflow),
    new Set([predicate]),
  );
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
    () => evaluator.evaluate(workflow, emptyContext(), "unrestricted"),
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
  const result = await evaluator.evaluate(def, emptyContext(), "unrestricted");
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
  const result = await evaluator.evaluate(def, emptyContext(), "unrestricted");
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
  const result = await evaluator.evaluate(def, emptyContext(), "unrestricted");
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
  const result = await evaluator.evaluate(def, emptyContext(), "unrestricted");
  assertEquals(
    result.getMethodArguments("run"),
    { vpc_id: "${{ model.foo.resource.bar.attributes.vpc_id }}" },
  );
});

// ---------------------------------------------------------------------------
// DefinitionExpressionEvaluator — authored-expression gate (swamp-club#2172)
// ---------------------------------------------------------------------------

Deno.test("DefinitionExpressionEvaluator: refuses an expression absent from the authored set", async () => {
  const evaluator = new DefinitionExpressionEvaluator(new CelEvaluator());
  // Stands in for a direct-execution definition synthesised from step inputs
  // the workflow evaluator already substituted data into.
  const def = Definition.create({
    name: "injected",
    methods: {
      run: { arguments: { run: "echo ${{ inputs.note }}" } },
    },
  });
  const result = await evaluator.evaluate(
    def,
    { ...emptyContext(), inputs: { note: "leaked" } },
    new Set<string>(),
  );
  assertEquals(
    result.getMethodArguments("run"),
    { run: "echo ${{ inputs.note }}" },
  );
});

Deno.test("DefinitionExpressionEvaluator: resolves an authored expression and refuses an injected one side by side", async () => {
  const evaluator = new DefinitionExpressionEvaluator(new CelEvaluator());
  const def = Definition.create({
    name: "mixed",
    methods: {
      run: {
        arguments: {
          authored: "${{ inputs.ok }}",
          injected: "${{ inputs.bad }}",
        },
      },
    },
  });
  const result = await evaluator.evaluate(
    def,
    { ...emptyContext(), inputs: { ok: "fine", bad: "leaked" } },
    new Set(["${{ inputs.ok }}"]),
  );
  assertEquals(
    result.getMethodArguments("run"),
    { authored: "fine", injected: "${{ inputs.bad }}" },
  );
});

// ---------------------------------------------------------------------------
// Task target deferral (swamp-club#2304)
//
// The target defers for either of two independent reasons: it reads step
// output, or its step carries a guard. The four combinations below pin both
// conditions and the case where neither applies.
// ---------------------------------------------------------------------------

/** Narrows a step's task data to the model_method form and returns its target. */
function targetOf(
  step: { task: { data: { type: string } } },
): string | undefined {
  const data = step.task.data;
  if (data.type !== "model_method") throw new Error("not a model_method task");
  return (data as { modelIdOrName?: string }).modelIdOrName;
}

/** A one-step workflow whose task target and guard are supplied by the test. */
function targetOnlyWorkflow(target: string, guard?: string): Workflow {
  return Workflow.create({
    name: "target-deferral",
    inputs: {
      type: "object",
      properties: { name: { type: "string", default: "picked" } },
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            guard,
            task: StepTask.model(target, "run"),
          }),
        ],
      }),
    ],
  });
}

async function evaluateTarget(
  target: string,
  guard?: string,
): Promise<string | undefined> {
  const workflow = targetOnlyWorkflow(target, guard);
  const authored = collectWorkflowAuthoredExpressions(workflow);
  const context = emptyContext();
  context.inputs = { name: "picked" };

  const { workflow: evaluated } = await new WorkflowExpressionEvaluator(
    new CelEvaluator(),
  ).evaluate(workflow, context, authored);

  return targetOf(evaluated.jobs[0].steps[0]);
}

Deno.test("target deferral: unguarded and static resolves at run start", async () => {
  // Neither condition applies, so the target resolves eagerly and a mistyped
  // name fails where the error is cheapest.
  assertEquals(await evaluateTarget("${{ inputs.name }}"), "picked");
});

Deno.test("target deferral: a guard defers an otherwise resolvable target", async () => {
  // The step may not run, so resolving its target is exactly the defect.
  assertEquals(
    await evaluateTarget("${{ inputs.name }}", "${{ true }}"),
    "${{ inputs.name }}",
  );
});

Deno.test("target deferral: a step-output dependency defers without any guard", async () => {
  // The data does not exist yet, so this defers on its own merits.
  const target = "${{ data.latest('m', 'rec').?attributes.?name.orValue('') }}";
  assertEquals(await evaluateTarget(target), target);
});

Deno.test("target deferral: both conditions together still defer", async () => {
  const target = "${{ data.latest('m', 'rec').?attributes.?name.orValue('') }}";
  assertEquals(await evaluateTarget(target, "${{ true }}"), target);
});

Deno.test("target deferral: a guard on one step does not defer another step's target", async () => {
  // Prefix matching is positional, so it must not leak across steps.
  const workflow = Workflow.create({
    name: "mixed-guards",
    inputs: {
      type: "object",
      properties: { name: { type: "string", default: "picked" } },
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "guarded",
            guard: "${{ true }}",
            task: StepTask.model("${{ inputs.name }}", "run"),
          }),
          Step.create({
            name: "plain",
            task: StepTask.model("${{ inputs.name }}", "run"),
          }),
        ],
      }),
    ],
  });
  const authored = collectWorkflowAuthoredExpressions(workflow);
  const context = emptyContext();
  context.inputs = { name: "picked" };

  const { workflow: evaluated } = await new WorkflowExpressionEvaluator(
    new CelEvaluator(),
  ).evaluate(workflow, context, authored);

  const steps = evaluated.jobs[0].steps;
  assertEquals(targetOf(steps[0]), "${{ inputs.name }}");
  assertEquals(targetOf(steps[1]), "picked");
});

Deno.test("target deferral: the direct-execution form defers its modelName too", async () => {
  // ADV-5 called modelName the riskier half: it names a definition to
  // auto-create, and every guarded step in the repo's own verification
  // workflow uses this form with a run-id-based name.
  const workflow = Workflow.create({
    name: "direct-execution-target",
    inputs: {
      type: "object",
      properties: { name: { type: "string", default: "picked" } },
    },
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "guarded",
            guard: "${{ true }}",
            task: StepTask.directExecution(
              "command/shell",
              "${{ inputs.name }}",
              "execute",
            ),
          }),
          Step.create({
            name: "plain",
            task: StepTask.directExecution(
              "command/shell",
              "${{ inputs.name }}",
              "execute",
            ),
          }),
        ],
      }),
    ],
  });
  const authored = collectWorkflowAuthoredExpressions(workflow);
  const context = emptyContext();
  context.inputs = { name: "picked" };

  const { workflow: evaluated } = await new WorkflowExpressionEvaluator(
    new CelEvaluator(),
  ).evaluate(workflow, context, authored);

  const nameOf = (step: { task: { data: { type: string } } }) => {
    const data = step.task.data;
    if (data.type !== "model_method") throw new Error("not a model_method");
    return (data as { modelName?: string }).modelName;
  };

  // Guarded defers; unguarded still resolves at run start, and the shared
  // expression text does not leak across them.
  assertEquals(nameOf(evaluated.jobs[0].steps[0]), "${{ inputs.name }}");
  assertEquals(nameOf(evaluated.jobs[0].steps[1]), "picked");
});

// ---------------------------------------------------------------------------
// Nested workflow targets and the steps namespace (swamp-club#2351)
//
// A driver step that picks the next workflow from a record an earlier step
// wrote had its workflowIdOrName evaluated at run start, before that record
// existed — silently taking the orValue fallback, or a previous run's value.
// A steps.* reference failed the whole run with "Unknown variable: steps".
// ---------------------------------------------------------------------------

/** Returns a nested workflow step's target. */
function workflowTargetOf(step: Step): string {
  const data = step.task.data;
  if (data.type !== "workflow") throw new Error("not a workflow task");
  return data.workflowIdOrName;
}

async function evaluateWith(workflow: Workflow) {
  const context = emptyContext();
  context.inputs = { name: "picked" };
  const { workflow: evaluated } = await new WorkflowExpressionEvaluator(
    new CelEvaluator(),
  ).evaluate(workflow, context, collectWorkflowAuthoredExpressions(workflow));
  return evaluated;
}

Deno.test("target deferral: a nested workflow target that reads step output defers", async () => {
  const target =
    "${{ data.latest('driver', 'next').?attributes.?workflow.orValue('fallback') }}";
  const evaluated = await evaluateWith(Workflow.create({
    name: "workflow-target",
    jobs: [Job.create({
      name: "job1",
      steps: [
        Step.create({ name: "dispatch", task: StepTask.workflow(target) }),
      ],
    })],
  }));

  assertEquals(workflowTargetOf(evaluated.jobs[0].steps[0]), target);
});

Deno.test("target deferral: a guard defers a nested workflow target but not an unguarded one", async () => {
  const evaluated = await evaluateWith(Workflow.create({
    name: "workflow-target-guards",
    inputs: {
      type: "object",
      properties: { name: { type: "string", default: "picked" } },
    },
    jobs: [Job.create({
      name: "job1",
      steps: [
        Step.create({
          name: "guarded",
          guard: "${{ true }}",
          task: StepTask.workflow("${{ inputs.name }}"),
        }),
        Step.create({
          name: "plain",
          task: StepTask.workflow("${{ inputs.name }}"),
        }),
      ],
    })],
  }));

  const steps = evaluated.jobs[0].steps;
  assertEquals(workflowTargetOf(steps[0]), "${{ inputs.name }}");
  assertEquals(workflowTargetOf(steps[1]), "picked");
});

Deno.test("target deferral: an input identical to a deferred workflow target stays deferred", async () => {
  // The reporter's collision: the input shares the target's text. Before the
  // fix the target evaluated at run start and substitution, keyed on the raw
  // text, wrote the same stale value into the input.
  const expression = "${{ data.latest('driver', 'next').attributes.workflow }}";
  const evaluated = await evaluateWith(Workflow.create({
    name: "workflow-target-collision",
    jobs: [Job.create({
      name: "job1",
      steps: [Step.create({
        name: "dispatch",
        task: StepTask.workflow(expression, { chosen: expression }),
      })],
    })],
  }));

  const task = evaluated.jobs[0].steps[0].task.data as {
    workflowIdOrName: string;
    inputs: Record<string, unknown>;
  };
  assertEquals(task.workflowIdOrName, expression);
  assertEquals(task.inputs.chosen, expression);
});

Deno.test("steps namespace: steps.* references stay raw at run start instead of failing the run", async () => {
  // The namespace only exists once the run does; evaluating it here used to
  // throw "Unknown variable: steps" and kill the run before any step ran.
  const input = "${{ steps.write.status }}";
  const target = "${{ steps.write.status == 'succeeded' ? 'next' : 'retry' }}";
  const evaluated = await evaluateWith(Workflow.create({
    name: "steps-namespace",
    jobs: [Job.create({
      name: "job1",
      steps: [
        Step.create({ name: "write", task: StepTask.model("writer", "run") }),
        Step.create({
          name: "consume",
          task: StepTask.model("consumer", "run", { status: input }),
        }),
        Step.create({ name: "dispatch", task: StepTask.workflow(target) }),
      ],
    })],
  }));

  const steps = evaluated.jobs[0].steps;
  assertEquals(
    (steps[1].task.data as { inputs: Record<string, unknown> }).inputs.status,
    input,
  );
  assertEquals(workflowTargetOf(steps[2]), target);
});

Deno.test("createTaskTargetDeferral: defers only task targets, by step-output dependency or guard", () => {
  const workflow = Workflow.create({
    name: "deferral-rule",
    jobs: [Job.create({
      name: "job1",
      steps: [
        Step.create({
          name: "guarded",
          guard: "${{ true }}",
          task: StepTask.workflow("${{ inputs.name }}"),
        }),
        Step.create({
          name: "plain",
          task: StepTask.model("${{ inputs.name }}", "run"),
        }),
      ],
    })],
  });
  const isDeferred = createTaskTargetDeferral(workflow);
  const location = (path: string, celExpression: string) => ({
    path,
    raw: `\${{ ${celExpression} }}`,
    celExpression,
  });

  // Guarded step: its target defers, its other fields do not.
  assertEquals(
    isDeferred(
      location("jobs[0].steps[0].task.workflowIdOrName", "inputs.name"),
    ),
    true,
  );
  assertEquals(
    isDeferred(location("jobs[0].steps[0].task.inputs.x", "inputs.name")),
    false,
  );
  // Unguarded step: only a step-output dependency defers its target.
  assertEquals(
    isDeferred(location("jobs[0].steps[1].task.modelIdOrName", "inputs.name")),
    false,
  );
  assertEquals(
    isDeferred(
      location(
        "jobs[0].steps[1].task.modelIdOrName",
        "data.latest('m', 'r').attributes.name",
      ),
    ),
    true,
  );
});
