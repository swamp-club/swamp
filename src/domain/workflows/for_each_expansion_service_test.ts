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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  InvalidExpressionError,
  SECRET_OPERATION_UNSUPPORTED,
  SecretRefusedError,
} from "../expressions/errors.ts";
import { VaultAccessDeniedError } from "../vaults/run_vault_access.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
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
  assertEquals(
    expanded?.map(({ forEachVar: { name, value } }) => ({ name, value })),
    [
      { name: "env", value: "dev" },
      { name: "env", value: "staging" },
      { name: "env", value: "prod" },
    ],
  );
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

Deno.test("ForEachExpansionService.expand: a control character in an item value is escaped in the expanded name (swamp-club#3027)", async () => {
  const service = new ForEachExpansionService(new CelEvaluator());
  const step = Step.create({
    name: "deploy-${{ self.host }}",
    forEach: { item: "host", in: "${{ ['a\\nb', 'c\\u001b]0;x\\u0007'] }}" },
    task: StepTask.model("infra", "create"),
  });
  const result = await service.expand(
    makeJobWithSteps([step]),
    makeExpressionContext(),
    "unrestricted",
  );

  const expanded = result.get("deploy-${{ self.host }}");
  assertEquals(expanded?.map((e) => e.expandedName), [
    "deploy-a\\x0ab",
    "deploy-c\\x1b]0;x\\x07",
  ]);
  // The item value itself is untouched; only the name is made printable.
  assertEquals(
    {
      name: expanded?.[0].forEachVar.name,
      value: expanded?.[0].forEachVar.value,
    },
    { name: "host", value: "a\nb" },
  );
});

Deno.test("resolveForEachStepName: a secret refusal in a name fails loudly instead of falling back, a composition leaves as a sentinel, and other failures keep the fallback (typed-secrets 4.1)", () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const sentinel = bag.addSecret({ vaultName: "prod", key: "A" }, "in");
  const typed = new CelEvaluator();
  const scoped = {
    evaluate: (expression: string, context: Record<string, unknown>) =>
      typed.evaluate(expression, context, { secretBag: bag }),
    evaluateAsync: (expression: string, context: Record<string, unknown>) =>
      typed.evaluateAsync(expression, context, { secretBag: bag }),
  };
  const ctx = makeStepContext({ item: { password: sentinel, name: "n" } });
  const error = assertThrows(
    () =>
      resolveForEachStepName(
        "step-${{ size(self.item.password) }}",
        true,
        ctx,
        scoped,
        "0",
        "unrestricted",
      ),
    SecretRefusedError,
  );
  assertEquals(error.code, SECRET_OPERATION_UNSUPPORTED);
  // A secret in the name leaves as its sentinel, for the stand-in to
  // replace; a composition (design Section 3.2) carries the sentinel too.
  const secret = resolveForEachStepName(
    "step-${{ self.item.password }}-${{ self.item.password + '-x' }}",
    true,
    ctx,
    scoped,
    "0",
    "unrestricted",
  );
  assertEquals(secret, {
    name: `step-${sentinel}-${sentinel}-x`,
    hadEvalFailure: false,
  });
  // An ordinary failure keeps today's fallback.
  const missing = resolveForEachStepName(
    "step-${{ self.item.missing.deep }}",
    true,
    ctx,
    scoped,
    "0",
    "unrestricted",
  );
  assertEquals(missing.hadEvalFailure, true);
  // A read the run's vault access denies, as the typed evaluate raises it
  // for a record the name reads, fails loudly too.
  const denial = new InvalidExpressionError(
    "Reading vault 'prod' is refused",
    "self.item.password",
    undefined,
    new VaultAccessDeniedError({
      vaultName: "prod",
      action: "read",
      reason: "not allowed",
    }),
  );
  const denying = {
    ...scoped,
    evaluate: (): unknown => {
      throw denial;
    },
  };
  assertThrows(
    () =>
      resolveForEachStepName(
        "step-${{ self.item.password }}",
        true,
        ctx,
        denying,
        "0",
        "unrestricted",
      ),
    InvalidExpressionError,
    "Reading vault 'prod' is refused",
  );
});

Deno.test("ForEachExpansionService.expand: in a typed run an item that holds a secret leaves forEach.in as a sentinel, the name takes sensitive-<index> from it, and prepare runs before each name (typed-secrets 4.1)", async () => {
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const sentinel = bag.addSecret({ vaultName: "prod", key: "A" }, "in");
  const typed = new CelEvaluator();
  const prepared: unknown[] = [];
  const pass = {
    evaluate: (expression: string, context: Record<string, unknown>) =>
      typed.evaluate(expression, context, { secretBag: bag }),
    evaluateAsync: (expression: string, context: Record<string, unknown>) =>
      typed.evaluateAsync(expression, context, { secretBag: bag }),
    prepare: (content: unknown, _context: Record<string, unknown>) => {
      prepared.push(content);
      return Promise.resolve();
    },
  };
  const values = new RunSensitiveValues(undefined, registry);
  const context = attachSensitiveValues(
    {
      model: {},
      env: {},
      inputs: {
        creds: [{ password: sentinel, host: "a" }, {
          password: sentinel,
          host: "b",
        }],
      },
    } as unknown as ExpressionContext,
    values,
  );
  const job = Job.create({
    name: "j",
    steps: [
      Step.create({
        name: "rotate-${{ self.c.password }}-${{ self.c.host }}",
        task: StepTask.model("db", "rotate"),
        forEach: { item: "c", in: "${{ inputs.creds }}" },
      }),
    ],
  });
  const expanded = await new ForEachExpansionService(pass).expand(
    job,
    context,
    "unrestricted",
  );
  const steps = expanded.get(
    "rotate-${{ self.c.password }}-${{ self.c.host }}",
  )!;
  assertEquals(steps.map((s) => s.expandedName), [
    "rotate-sensitive-0-a",
    "rotate-sensitive-1-b",
  ]);
  // The item binds the sentinel text the later passes read as a Secret.
  assertEquals(
    steps.map((s) => (s.forEachVar.value as { password: string }).password),
    [sentinel, sentinel],
  );
  assertEquals(prepared.length, 2);
  // Nothing was issued beyond the fixture's entry: the name's Secret is the
  // bound sentinel itself.
  assertEquals(registry.isEmpty, false);
  // A plain evaluator, with no prepare, expands as before.
  const plain = await new ForEachExpansionService(new CelEvaluator()).expand(
    job,
    context,
    "unrestricted",
  );
  assertEquals(
    plain.get("rotate-${{ self.c.password }}-${{ self.c.host }}")!.map((s) =>
      s.expandedName
    ),
    ["rotate-sensitive-0-a", "rotate-sensitive-1-b"],
  );
});
