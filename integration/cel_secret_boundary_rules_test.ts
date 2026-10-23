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

// Architectural fitness test: Secret stays inside the CEL adapter and every
// internal evaluator uses it. Separate extension/query/grant environments retain
// their own contracts (design/enablers/typed-secrets.md Sections 3.2 and 10.3).

import { assert } from "@std/assert";
import {
  assertPinnedSet,
  collectImportEdges,
  constructorCalls,
  isCommentLine,
  isUnder,
  productionSourceFiles,
  repoRelative,
  resolveImport,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const CEL_ADAPTER = "src/infrastructure/cel";

/** The modules that make, register, record or convert a `Secret`. */
const SECRET_MODULES: ReadonlySet<string> = new Set([
  "src/infrastructure/cel/cel_vault_namespace.ts",
  "src/infrastructure/cel/secret_value.ts",
  "src/infrastructure/cel/secret_registrations.ts",
  "src/infrastructure/cel/secret_fault_context.ts",
  "src/infrastructure/cel/secret_boundary.ts",
  "src/infrastructure/cel/sensitive_record_adapter.ts",
  "src/infrastructure/cel/query_view.ts",
]);

Deno.test("no production code outside the CEL adapter imports a Secret module", async () => {
  const edges = await collectImportEdges(SRC_DIR, (filePath, importPath) => {
    const target = resolveImport(filePath, importPath);
    return target !== undefined && SECRET_MODULES.has(target);
  });
  // The scan sees the adapter's own imports, so an empty result below is
  // not a scan that matched nothing.
  for (
    const edge of [
      "src/infrastructure/cel/cel_evaluator.ts -> src/infrastructure/cel/secret_boundary.ts",
      "src/infrastructure/cel/cel_evaluator.ts -> src/infrastructure/cel/sensitive_record_adapter.ts",
      "src/infrastructure/cel/cel_evaluator.ts -> src/infrastructure/cel/query_view.ts",
    ]
  ) {
    assert(edges.includes(edge), edges.join("\n"));
  }
  const outside = edges.filter((edge) =>
    !isUnder(edge.split(" -> ")[0], CEL_ADAPTER)
  );
  assertPinnedSet(
    outside,
    [],
    "Secret module imports outside src/infrastructure/cel",
    "A Secret leaves CEL as a sentinel (secret_boundary.ts); code outside " +
      "the adapter works with sentinels and never sees a Secret. Convert at " +
      "the boundary instead of importing the Secret modules.",
  );
});

Deno.test("internal evaluators have no rollout switch", async () => {
  const constructed: string[] = [];
  const literals: string[] = [];
  const built: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    const source = await Deno.readTextFile(filePath);
    for (const className of ["CelEvaluator", "SecretBagRegistry"]) {
      for (const call of constructorCalls(source, className)) {
        if (call.args.length === 0) continue;
        // Whitespace and a trailing comma are the formatter's, not the shape's.
        const args = call.args.join(", ").replace(/\s+/g, " ").replace(
          /,\s*([}\])])/g,
          " $1",
        );
        constructed.push(`${rel} new ${className}(${args})`);
      }
    }
    source.split("\n").forEach((line, index) => {
      if (isCommentLine(line)) return;
      // An enabling literal anywhere is a production switch, whatever
      // wrapper carries it: the backstop behind the pinned forwarding sites.
      if (/\btypedSecrets\b/.test(line)) {
        literals.push(`${rel}:${index + 1}`);
      }
      if (rel === `${CEL_ADAPTER}/cel_evaluator.ts`) return;
      if (/\bcreateInternalCelEnvironment\(/.test(line)) {
        built.push(`${rel}:${index + 1}`);
      }
    });
  }
  const policy = "Every internal expression entry point uses typed secrets. " +
    "Do not reintroduce a rollout switch or an untyped internal environment.";
  assertPinnedSet(
    constructed,
    [],
    "new CelEvaluator( or new SecretBagRegistry( with options in production code",
    policy,
  );
  assertPinnedSet(
    literals,
    [],
    "typedSecrets in production code",
    policy,
  );
  assertPinnedSet(
    built,
    [],
    "createInternalCelEnvironment( outside cel_evaluator.ts",
    policy,
  );
});
