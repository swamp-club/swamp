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

import { assertEquals, assertRejects } from "@std/assert";
import {
  ForEachExpansionService,
  resolveForEachStepName,
} from "./for_each_expansion_service.ts";
import { Job } from "./job.ts";
import { RunSensitiveValues } from "../secrets/mod.ts";
import { attachSensitiveValues } from "../expressions/sensitive_context.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import type { ExpressionContext } from "../expressions/model_resolver.ts";
import { UserError } from "../errors.ts";

// ---------------------------------------------------------------------------
// resolveForEachStepName — pure helper, no I/O
// ---------------------------------------------------------------------------

function makeStepContext(
  vars: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    self: {
      id: "test-id",
      name: "test",
      ...vars,
    },
  };
}

Deno.test("resolveForEachStepName: resolves single expression in template", () => {
  const cel = new CelEvaluator();
  const ctx = makeStepContext({ item: "hello" });
  const result = resolveForEachStepName(
    "step-${{ self.item }}",
    true,
    ctx,
    cel,
    "fallback",
    "unrestricted",
  );
  assertEquals(result.name, "step-hello");
  assertEquals(result.hadEvalFailure, false);
});

Deno.test("resolveForEachStepName: resolves multiple expressions in template", () => {
  const cel = new CelEvaluator();
  const ctx = makeStepContext({ show: "MyShow", title: "Episode1" });
  const result = resolveForEachStepName(
    "dl-${{ self.show }}-${{ self.title }}",
    true,
    ctx,
    cel,
    "0",
    "unrestricted",
  );
  assertEquals(result.name, "dl-MyShow-Episode1");
  assertEquals(result.hadEvalFailure, false);
});

Deno.test("resolveForEachStepName: appends fallback suffix when expression fails", () => {
  const cel = new CelEvaluator();
  const ctx = makeStepContext();
  const result = resolveForEachStepName(
    "step-${{ self.missing.deep.field }}",
    true,
    ctx,
    cel,
    "0",
    "unrestricted",
  );
  assertEquals(result.name, "step-${{ self.missing.deep.field }}-0");
  assertEquals(result.hadEvalFailure, true);
});

Deno.test("resolveForEachStepName: appends fallback suffix when no expressions", () => {
  const cel = new CelEvaluator();
  const ctx = makeStepContext();
  const result = resolveForEachStepName(
    "download",
    false,
    ctx,
    cel,
    "my-key",
    "unrestricted",
  );
  assertEquals(result.name, "download-my-key");
  assertEquals(result.hadEvalFailure, false);
});

Deno.test("resolveForEachStepName: uses numeric fallback suffix for index-based naming", () => {
  const cel = new CelEvaluator();
  const ctx = makeStepContext();
  const result = resolveForEachStepName(
    "process",
    false,
    ctx,
    cel,
    "3",
    "unrestricted",
  );
  assertEquals(result.name, "process-3");
  assertEquals(result.hadEvalFailure, false);
});

Deno.test("resolveForEachStepName: resolves expression with object property access", () => {
  const cel = new CelEvaluator();
  const ctx = makeStepContext({ ep: { attributes: { show: "Futurama" } } });
  const result = resolveForEachStepName(
    "dl-${{ self.ep.attributes.show }}",
    true,
    ctx,
    cel,
    "0",
    "unrestricted",
  );
  assertEquals(result.name, "dl-Futurama");
  assertEquals(result.hadEvalFailure, false);
});

Deno.test("resolveForEachStepName: mixed resolved and failed expressions appends suffix", () => {
  const cel = new CelEvaluator();
  const ctx = makeStepContext({ item: "resolved" });
  const result = resolveForEachStepName(
    "${{ self.item }}-${{ self.nonexistent.deep }}",
    true,
    ctx,
    cel,
    "0",
    "unrestricted",
  );
  assertEquals(result.name, "resolved-${{ self.nonexistent.deep }}-0");
  assertEquals(result.hadEvalFailure, true);
});

// ---------------------------------------------------------------------------
// ForEachExpansionService.expand — class-level unit tests
// ---------------------------------------------------------------------------

function makeExpressionContext(): ExpressionContext {
  return { model: {}, env: {} };
}

function makeJobWithSteps(steps: Step[]): Job {
  return Job.create({ name: "test-job", steps });
}

Deno.test("ForEachExpansionService.expand: non-forEach step yields one entry that mirrors the template", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "plain-step",
    task: StepTask.model("m", "run"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  const expanded = result.get("plain-step");
  assertEquals(expanded?.length, 1);
  assertEquals(expanded?.[0].expandedName, "plain-step");
  assertEquals(expanded?.[0].forEachVar, { name: "", value: undefined });
  // The template step is preserved by reference.
  assertEquals(expanded?.[0].step, step);
});

Deno.test("ForEachExpansionService.expand: array iteration produces one entry per item with correct forEachVar", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "scan-${{ self.env }}",
    forEach: { item: "env", in: "${{ ['dev', 'staging', 'prod'] }}" },
    task: StepTask.model("scanner", "run"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  const expanded = result.get("scan-${{ self.env }}");
  assertEquals(expanded?.length, 3);
  assertEquals(expanded?.map((e) => e.expandedName), [
    "scan-dev",
    "scan-staging",
    "scan-prod",
  ]);
  assertEquals(expanded?.map((e) => e.forEachVar), [
    { name: "env", value: "dev" },
    { name: "env", value: "staging" },
    { name: "env", value: "prod" },
  ]);
});

Deno.test("ForEachExpansionService.expand: object iteration binds {key, value} objects", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "deploy-${{ self.region.key }}",
    forEach: {
      item: "region",
      in: "${{ {'emea': 'eu-west-1', 'amer': 'us-east-1'} }}",
    },
    task: StepTask.model("deployer", "run"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  const expanded = result.get("deploy-${{ self.region.key }}");
  assertEquals(expanded?.length, 2);
  assertEquals(expanded?.map((e) => e.expandedName).sort(), [
    "deploy-amer",
    "deploy-emea",
  ]);
  // Each entry's forEachVar.value is the {key, value} pair (not the raw value).
  for (const entry of expanded ?? []) {
    const v = entry.forEachVar.value as { key: string; value: string };
    assertEquals(typeof v.key, "string");
    assertEquals(typeof v.value, "string");
    // Sanity: the binding shape matches the documented {key, value} contract.
    assertEquals(Object.keys(v).sort(), ["key", "value"]);
  }
});

Deno.test("ForEachExpansionService.expand: throws UserError when forEach.in is not in `${{ }}` form", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "bad",
    forEach: { item: "x", in: "[1, 2, 3]" },
    task: StepTask.model("m", "run"),
  });
  await assertRejects(
    () =>
      service.expand(
        makeJobWithSteps([step]),
        makeExpressionContext(),
        "unrestricted",
      ),
    UserError,
    "Invalid forEach.in expression",
  );
});

Deno.test("ForEachExpansionService.expand: throws UserError when forEach.in evaluates to a non-iterable", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "bad",
    forEach: { item: "x", in: "${{ 42 }}" },
    task: StepTask.model("m", "run"),
  });
  await assertRejects(
    () =>
      service.expand(
        makeJobWithSteps([step]),
        makeExpressionContext(),
        "unrestricted",
      ),
    UserError,
    "must evaluate to an array or object",
  );
});

Deno.test("ForEachExpansionService.expand: empty array yields zero expansions but preserves the entry", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "scan-${{ self.env }}",
    forEach: { item: "env", in: "${{ [] }}" },
    task: StepTask.model("scanner", "run"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  const expanded = result.get("scan-${{ self.env }}");
  // Map entry exists (caller distinguishes "no expansion" from "step not seen")
  // but the array is empty.
  assertEquals(expanded?.length, 0);
});

Deno.test("ForEachExpansionService: a sensitive item never becomes part of a step name (swamp-club#2171)", async () => {
  const values = new RunSensitiveValues();
  values.addSecret("Pl41n-s3cret", { vaultName: "prod", key: "api-token" });
  const context = attachSensitiveValues(
    { model: {}, env: {}, inputs: { items: ["Pl41n-s3cret", "public"] } },
    values,
  );
  const job = Job.create({
    name: "j",
    steps: [Step.create({
      name: "deploy",
      forEach: { item: "tok", in: "${{ inputs.items }}" },
      task: StepTask.model("m", "run"),
    })],
  });
  const expanded = await new ForEachExpansionService(new CelEvaluator())
    .expand(job, context, "unrestricted");
  assertEquals(
    expanded.get("deploy")!.map((s) => s.expandedName),
    ["deploy-sensitive-0", "deploy-public"],
  );
  // The iteration variable keeps the real value for the step to use.
  assertEquals(expanded.get("deploy")![0].forEachVar.value, "Pl41n-s3cret");
});

Deno.test("ForEachExpansionService.expand: self._index names each array iteration by its position (swamp-club#2348)", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "process-${{ self._index }}",
    forEach: { item: "file", in: "${{ ['src/a.ts', 'src/b/c.ts'] }}" },
    task: StepTask.model("processor", "run"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  const expanded = result.get("process-${{ self._index }}");
  assertEquals(expanded?.map((e) => e.expandedName), [
    "process-0",
    "process-1",
  ]);
});

Deno.test("ForEachExpansionService.expand: self._index follows key order for object iteration (swamp-club#2348)", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "deploy-${{ self.region.key }}-${{ self._index }}",
    forEach: {
      item: "region",
      in: "${{ {'emea': 'eu-west-1', 'amer': 'us-east-1'} }}",
    },
    task: StepTask.model("deployer", "run"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  const expanded = result.get(
    "deploy-${{ self.region.key }}-${{ self._index }}",
  );
  assertEquals(
    expanded?.map((e) => e.expandedName),
    expanded?.map((e, i) =>
      `deploy-${(e.forEachVar.value as { key: string }).key}-${i}`
    ),
  );
});

Deno.test("ForEachExpansionService.expand: an item named _index shadows the iteration index (swamp-club#2348)", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "scan-${{ self._index }}",
    forEach: { item: "_index", in: "${{ ['dev', 'prod'] }}" },
    task: StepTask.model("scanner", "run"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  assertEquals(
    result.get("scan-${{ self._index }}")?.map((e) => e.expandedName),
    ["scan-dev", "scan-prod"],
  );
});
