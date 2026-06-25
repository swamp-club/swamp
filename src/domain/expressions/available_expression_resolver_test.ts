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
import {
  resolveAvailableExpressions,
  type SyncCelEvaluator,
} from "./available_expression_resolver.ts";

/**
 * Deterministic stub evaluator: resolves a dotted CEL path against the context
 * and throws when any segment is missing — mirroring how the real CEL evaluator
 * fails on an unbound reference. Records the expressions it was asked to
 * evaluate so tests can assert deferred kinds are never evaluated.
 */
function makeEvaluator(): { evaluate: SyncCelEvaluator; calls: string[] } {
  const calls: string[] = [];
  const evaluate: SyncCelEvaluator = (expr, ctx) => {
    calls.push(expr);
    const parts = expr.split(".");
    let cur: unknown = ctx;
    for (const part of parts) {
      if (cur === null || typeof cur !== "object" || !(part in cur)) {
        throw new Error(`unbound reference: ${expr}`);
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  };
  return { evaluate, calls };
}

Deno.test("resolveAvailableExpressions: resolves self.* in a target string", () => {
  const { evaluate } = makeEvaluator();
  const result = resolveAvailableExpressions(
    { workflowIdOrName: "${{ self.item.impl }}" },
    { self: { item: { impl: "lab-capability-ssh" } } },
    evaluate,
  );
  assertEquals(result, { workflowIdOrName: "lab-capability-ssh" });
});

Deno.test("resolveAvailableExpressions: whole-string single expression keeps native type", () => {
  const { evaluate } = makeEvaluator();
  const result = resolveAvailableExpressions(
    {
      inputs: { count: "${{ self.item.count }}", obj: "${{ self.item.obj }}" },
    },
    { self: { item: { count: 5, obj: { a: 1 } } } },
    evaluate,
  ) as { inputs: { count: unknown; obj: unknown } };
  assertEquals(result.inputs.count, 5);
  assertEquals(typeof result.inputs.count, "number");
  assertEquals(result.inputs.obj, { a: 1 });
});

Deno.test("resolveAvailableExpressions: embedded multi-expression string substitutes all", () => {
  const { evaluate } = makeEvaluator();
  const result = resolveAvailableExpressions(
    { name: "apply-${{ self.item.host }}-${{ self.item.capability }}" },
    { self: { item: { host: "gitea", capability: "ssh" } } },
    evaluate,
  );
  assertEquals(result, { name: "apply-gitea-ssh" });
});

Deno.test("resolveAvailableExpressions: vault and env expressions are always left raw", () => {
  const { evaluate, calls } = makeEvaluator();
  const data = {
    a: '${{ vault.get("secret") }}',
    b: "${{ env.HOME }}",
  };
  const result = resolveAvailableExpressions(data, {}, evaluate);
  assertEquals(result, data);
  // Deferred kinds must never be handed to the evaluator.
  assertEquals(calls, []);
});

Deno.test("resolveAvailableExpressions: step-output / data.* dependencies are left raw", () => {
  const { evaluate, calls } = makeEvaluator();
  const data = {
    a: '${{ data.latest("spec", "name") }}',
    b: "${{ model.foo.resource.bar }}",
  };
  const result = resolveAvailableExpressions(data, {}, evaluate);
  assertEquals(result, data);
  assertEquals(calls, []);
});

Deno.test("resolveAvailableExpressions: run.* resolves when in context, stays raw when not", () => {
  const { evaluate } = makeEvaluator();

  // run not in context -> evaluator throws -> left raw (the evaluate-stage case)
  const evalStage = resolveAvailableExpressions(
    { modelIdOrName: "scan-${{ run.id }}" },
    { self: { item: {} } },
    evaluate,
  );
  assertEquals(evalStage, { modelIdOrName: "scan-${{ run.id }}" });

  // run in context -> resolves (the execution-stage case)
  const runStage = resolveAvailableExpressions(
    { modelIdOrName: "scan-${{ run.id }}" },
    { run: { id: "abc123" } },
    evaluate,
  );
  assertEquals(runStage, { modelIdOrName: "scan-abc123" });
});

Deno.test("resolveAvailableExpressions: a bad reference is left raw", () => {
  const { evaluate } = makeEvaluator();
  const result = resolveAvailableExpressions(
    { workflowIdOrName: "${{ self.item.typo }}" },
    { self: { item: { impl: "real" } } },
    evaluate,
  );
  assertEquals(result, { workflowIdOrName: "${{ self.item.typo }}" });
});

Deno.test("resolveAvailableExpressions: walks nested objects and arrays", () => {
  const { evaluate } = makeEvaluator();
  const result = resolveAvailableExpressions(
    {
      task: {
        workflowIdOrName: "${{ self.item.impl }}",
        inputs: {
          hosts: ["${{ self.item.host }}", "static"],
          nested: { vm: "${{ self.item.vm }}" },
        },
      },
    },
    { self: { item: { impl: "wf-a", host: "h1", vm: "vm1" } } },
    evaluate,
  );
  assertEquals(result, {
    task: {
      workflowIdOrName: "wf-a",
      inputs: {
        hosts: ["h1", "static"],
        nested: { vm: "vm1" },
      },
    },
  });
});

Deno.test("resolveAvailableExpressions: leaves expression-free data untouched and returns input when nothing to resolve", () => {
  const { evaluate, calls } = makeEvaluator();
  const data = { workflowIdOrName: "static-name", inputs: { n: 1 } };
  const result = resolveAvailableExpressions(data, {}, evaluate);
  assertEquals(result, data);
  assertEquals(calls, []);
});
