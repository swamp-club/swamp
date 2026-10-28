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

// Pins the actual calls at the typed-secrets loading/evaluation boundary.
// Babel is already the source parser used by the barrel fitness rule. Parsing
// here excludes comments, strings and declarations and catches multiline calls.
import { parse } from "@babel/parser";
import {
  assertEquals,
  assertGreater,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  assertPinnedSet,
  countedKeys,
  productionSourceFiles,
  repoRelative,
  ROOT,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

interface Node {
  type: string;
  [key: string]: unknown;
}

const METHODS = new Set([
  "resolveDeep",
  "evaluateAsync",
  "resolveRuntimeExpressionsInData",
  "resolveAllExpressionsInData",
]);

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null &&
    typeof (value as Node).type === "string";
}

function nameOf(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "PrivateName") return `#${nameOf(node.id)}`;
  return typeof node.name === "string"
    ? node.name
    : typeof node.value === "string"
    ? node.value
    : undefined;
}

function callSites(source: string, file: string): string[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: [
      "typescript",
      "explicitResourceManagement",
      "importAttributes",
      "decorators",
      ...(file.endsWith("x") ? ["jsx" as const] : []),
    ],
  });
  const found: string[] = [];
  const visit = (node: Node, owner: string): void => {
    if (
      node.type === "ClassDeclaration" || node.type === "FunctionDeclaration"
    ) {
      owner = nameOf(node.id) ?? owner;
    } else if (
      node.type === "ClassMethod" || node.type === "ClassPrivateMethod"
    ) {
      owner = `${owner}.${nameOf(node.key) ?? "<method>"}`;
    }
    if (
      node.type === "CallExpression" || node.type === "OptionalCallExpression"
    ) {
      const callee = node.callee;
      if (isNode(callee)) {
        const member = callee.type === "MemberExpression" ||
          callee.type === "OptionalMemberExpression";
        const method = nameOf(member ? callee.property : callee);
        if (method && METHODS.has(method)) {
          const receiver = member && isNode(callee.object)
            ? source.slice(
              Number(callee.object.start),
              Number(callee.object.end),
            ).replace(/\s+/g, "") + "."
            : "";
          found.push(`${file}: ${owner} -> ${receiver}${method}`);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key.endsWith("Comments")) continue;
      if (isNode(value)) visit(value, owner);
      else if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item, owner);
      }
    }
  };
  visit(ast as unknown as Node, "<module>");
  return countedKeys(found);
}

/** Each call maps to a Section 3.3 row, or a Section 5 pass/bag implementation. */
const PINNED: readonly { site: string; row: string }[] = [
  {
    "site":
      "src/domain/expressions/definition_expression_pass.ts: evaluateDefinitionExpressions -> celEvaluator.evaluateAsync",
    "row": "pass",
  },
  {
    "site":
      "src/domain/expressions/expression_evaluation_service.ts: ExpressionEvaluationService.evaluateDataValues -> passEvaluator.evaluateAsync",
    "row": "pass",
  },
  {
    "site":
      "src/domain/expressions/expression_evaluation_service.ts: ExpressionEvaluationService.passEvaluatorFor -> evaluator.evaluateAsync",
    "row": "pass",
  },
  {
    "site":
      "src/domain/expressions/expression_evaluation_service.ts: ExpressionEvaluationService.resolveAllExpressionsInData -> this.resolveRuntimeExpressionsInData",
    "row": "runtime",
  },
  {
    "site":
      "src/domain/expressions/expression_evaluation_service.ts: ExpressionEvaluationService.resolveRuntimeData -> evaluator.evaluateAsync",
    "row": "pass",
  },
  {
    "site":
      "src/domain/expressions/expression_evaluation_service.ts: ExpressionEvaluationService.resolveRuntimeExpressionsInData -> loaded.resolveDeep",
    "row": "runtime",
  },
  {
    "site":
      "src/domain/models/method_execution_service.ts: DefaultMethodExecutionService.#legacyDelivery -> secretBag.resolveDeep (x3)",
    "row": "delivery",
  },
  {
    "site":
      "src/domain/models/method_execution_service.ts: DefaultMethodExecutionService.#prepareDelivery -> secretBag.resolveDeep",
    "row": "delivery",
  },
  {
    "site":
      "src/domain/models/method_execution_service.ts: parseMethodArguments -> secretBag.resolveDeep (x2)",
    "row": "delivery",
  },
  {
    "site":
      "src/domain/vaults/vault_secret_bag.ts: VaultSecretBag.resolveDeep -> this.resolveDeep (x2)",
    "row": "bag-recursion",
  },
  {
    "site":
      "src/domain/workflows/execution_service.ts: DefaultStepExecutor.executeModelMethod -> expressionEvaluator.resolveAllExpressionsInData",
    "row": "routing",
  },
  {
    "site":
      "src/domain/workflows/execution_service.ts: DefaultStepExecutor.executeModelMethod -> expressionEvaluator.resolveRuntimeExpressionsInData",
    "row": "routing",
  },
  {
    "site":
      "src/domain/workflows/execution_service.ts: WorkflowExecutionService.runStepInSpan -> celEvaluator.evaluateAsync (x2)",
    "row": "pass",
  },
  {
    "site":
      "src/domain/workflows/execution_service.ts: WorkflowExecutionService.runStepInSpan -> messageEvaluator.evaluateAsync",
    "row": "assert-message",
  },
  {
    "site":
      "src/domain/workflows/execution_service.ts: WorkflowExecutionService.runWorkflowStep -> this.expressionEvaluator.resolveRuntimeExpressionsInData",
    "row": "child",
  },
  {
    "site":
      "src/domain/workflows/execution_service.ts: resolveRecordExpression -> evaluator.evaluateAsync",
    "row": "deferred",
  },
  {
    "site":
      "src/domain/workflows/execution_service.ts: resolveScalarExpression -> celEvaluator.evaluateAsync (x2)",
    "row": "deferred",
  },
  {
    "site":
      "src/domain/workflows/expression_evaluators.ts: WorkflowExpressionEvaluator.evaluate -> this.celEvaluator.evaluateAsync",
    "row": "pass",
  },
  {
    "site":
      "src/domain/workflows/for_each_expansion_service.ts: ForEachExpansionService.expand -> this.celEvaluator.evaluateAsync",
    "row": "pass",
  },
  {
    "site":
      "src/domain/workflows/trigger_input_resolver.ts: TriggerInputResolver.resolveString -> this.celEvaluator.evaluateAsync (x2)",
    "row": "pass",
  },
  {
    "site":
      "src/libswamp/models/validate.ts: deliverCheckArguments -> loaded.resolveDeep",
    "row": "validation",
  },
  {
    "site":
      "src/libswamp/workflows/evaluate.ts: evaluateWorkflowInternal -> pass.evaluateAsync",
    "row": "pass",
  },
];

Deno.test("inline secret resolution: every evaluation and loading call is pinned to its destination", async () => {
  const found: string[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    // Avoid parsing files that cannot contain a relevant call.
    if (![...METHODS].some((name) => source.includes(name))) continue;
    found.push(...callSites(source, repoRelative(path)));
  }
  assertGreater(found.length, 20);
  assertPinnedSet(
    found.sort(),
    PINNED.map((p) => p.site).sort(),
    "Inline secret resolution sites",
    "Add a Section 3.3 destination row and pin the caller here; Section 5 passes and trusted deliveries are explicit exceptions, never whole-file exemptions.",
  );
  const doc = await Deno.readTextFile(
    join(ROOT, "design", "enablers", "typed-secrets.md"),
  );
  const section = doc.slice(doc.indexOf("### 3.3 "), doc.indexOf("### 3.4 "));
  const rows = section.split("\n").flatMap((line) => {
    const match = /^\|\s*`([a-z-]+)`\s*\|/.exec(line);
    return match ? [match[1]] : [];
  });
  assertPinnedSet(
    rows,
    [...new Set(PINNED.map((p) => p.row))].filter((row) =>
      row !== "pass" && row !== "bag-recursion"
    ),
    "Section 3.3 inline destination rows",
    "Each inline destination row must have an inventoried caller.",
  );
  for (const { row } of PINNED) {
    if (row === "pass" || row === "bag-recursion") continue;
    assertStringIncludes(section, `\`${row}\``);
  }
});

Deno.test("inline secret resolution: scanner detects additions, removals and duplicates in the same method, including multiline and computed calls", () => {
  const source = `class Example {
    // bag.resolveDeep(secret)
    evaluateAsync() { return "evaluator.evaluateAsync(secret)"; }
    async run() {
      return await evaluator
        .evaluateAsync(source, {});
    }
  }`;
  const site = "example.ts: Example.run -> evaluator.evaluateAsync";
  assertEquals(callSites(source, "example.ts"), [site]);
  const duplicate = source.replace(
    "return await",
    "await evaluator['evaluateAsync']('again', {}); return await",
  );
  assertEquals(callSites(duplicate, "example.ts"), [`${site} (x2)`]);
  assertThrows(() =>
    assertPinnedSet(
      callSites(duplicate, "example.ts"),
      [site],
      "sites",
      "policy",
    )
  );
  assertThrows(() => assertPinnedSet([], [site], "sites", "policy"));
  const additional = `${source}\nfunction added() { bag.resolveDeep(value); }`;
  assertThrows(() =>
    assertPinnedSet(
      callSites(additional, "example.ts"),
      [site],
      "sites",
      "policy",
    )
  );
});

Deno.test("inline secret resolution: the deprecated vault resolvers have no production definitions or callers", async () => {
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    assertEquals(
      /\bresolveVaultExpressionsIn(?:Definition|Data)\b/.test(source),
      false,
      repoRelative(path),
    );
  }
});
