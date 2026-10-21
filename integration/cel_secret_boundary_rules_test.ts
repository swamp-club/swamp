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

// Architectural fitness test: the typed-secrets `Secret` stays inside the CEL
// adapter, and only tests turn it on (design/enablers/typed-secrets.md
// Sections 3.2, 10.3 and 12.1).
//
// - No code outside src/infrastructure/cel/ imports the modules that make,
//   register, record or convert a `Secret`: everything else sees sentinels.
// - Until Phase 4 turns typed secrets on for every entry point, no production
//   code sets the internal option: no `new CelEvaluator(` passes an argument,
//   no `new SecretBagRegistry(` passes an argument (the registry flag that
//   turns on the destination policies of typed-secrets 3.4), and no file but
//   cel_evaluator.ts builds the internal environment. The scan reads those
//   call shapes only; a factory or wrapper that forwards options to any of
//   them would pass it, so give such a wrapper its own check.

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

/**
 * The two places production code constructs with options, each forwarding
 * an existing registry's flag and never a literal (typed-secrets 3.5): the
 * evaluation service builds the typed evaluator from the run's registry,
 * and a registry builds an independent sibling for a nested invocation.
 * Pinned by file and argument shape, so a third site, or a changed shape,
 * needs a decision here.
 */
const FORWARDING_SITES: readonly string[] = [
  "src/domain/expressions/expression_evaluation_service.ts new CelEvaluator({ typedSecrets: registry.typedSecrets })",
  "src/domain/vaults/secret_bag_registry.ts new SecretBagRegistry({ typedSecrets: this.typedSecrets })",
];

Deno.test("no production code sets the typed-secrets option", async () => {
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
      if (/\btypedSecrets\s*[:=]\s*true\b/.test(line)) {
        literals.push(`${rel}:${index + 1}`);
      }
      if (rel === `${CEL_ADAPTER}/cel_evaluator.ts`) return;
      if (/\bcreateInternalCelEnvironment\(/.test(line)) {
        built.push(`${rel}:${index + 1}`);
      }
    });
  }
  const policy = "Typed secrets stay behind the internal option, set only by " +
    "tests, until typed-secrets Phase 4 turns the path on for every entry " +
    "point (design Section 10.3). Production code may forward an existing " +
    "registry's flag at the pinned sites, never set it.";
  assertPinnedSet(
    constructed,
    FORWARDING_SITES,
    "new CelEvaluator( or new SecretBagRegistry( with options in production code",
    policy,
  );
  assertPinnedSet(
    literals,
    [],
    "typedSecrets set to true in production code",
    policy,
  );
  assertPinnedSet(
    built,
    [],
    "createInternalCelEnvironment( outside cel_evaluator.ts",
    policy,
  );
});
