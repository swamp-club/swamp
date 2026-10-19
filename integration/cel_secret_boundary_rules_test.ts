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
//   and no file but cel_evaluator.ts builds the internal environment.

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
  "src/infrastructure/cel/secret_value.ts",
  "src/infrastructure/cel/secret_registrations.ts",
  "src/infrastructure/cel/secret_fault_context.ts",
  "src/infrastructure/cel/secret_boundary.ts",
]);

Deno.test("no production code outside the CEL adapter imports a Secret module", async () => {
  const edges = await collectImportEdges(SRC_DIR, (filePath, importPath) => {
    const target = resolveImport(filePath, importPath);
    return target !== undefined && SECRET_MODULES.has(target);
  });
  // The scan sees the adapter's own imports, so an empty result below is
  // not a scan that matched nothing.
  assert(
    edges.includes(
      "src/infrastructure/cel/cel_evaluator.ts -> src/infrastructure/cel/secret_boundary.ts",
    ),
    edges.join("\n"),
  );
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

Deno.test("no production code sets the typed-secrets option", async () => {
  const constructed: string[] = [];
  const built: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    const source = await Deno.readTextFile(filePath);
    for (const call of constructorCalls(source, "CelEvaluator")) {
      if (call.args.length > 0) constructed.push(`${rel}:${call.line + 1}`);
    }
    if (rel === `${CEL_ADAPTER}/cel_evaluator.ts`) continue;
    source.split("\n").forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (/\bcreateInternalCelEnvironment\(/.test(line)) {
        built.push(`${rel}:${index + 1}`);
      }
    });
  }
  const policy = "Typed secrets stay behind the internal option, set only by " +
    "tests, until typed-secrets Phase 4 turns the path on for every entry " +
    "point (design Section 10.3).";
  assertPinnedSet(
    constructed,
    [],
    "new CelEvaluator( with options in production code",
    policy,
  );
  assertPinnedSet(
    built,
    [],
    "createInternalCelEnvironment( outside cel_evaluator.ts",
    policy,
  );
});
