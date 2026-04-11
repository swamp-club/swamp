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

// Architecture guard: production MethodContext construction must go through
// buildMethodContext. This test walks src/ and fails if a new inline
// MethodContext object literal appears outside the allowed files. If this
// test fails, route the construction through buildMethodContext in
// src/domain/models/method_context.ts.

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { relative } from "@std/path";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const SRC_ROOT = `${REPO_ROOT}src`;

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The factory itself.
  "src/domain/models/method_context.ts",
  // The interface declaration uses `MethodContext["logger"]` typeof lookups.
  "src/domain/models/model.ts",
  // Spread-based enrichment overlays `globalArgs`/`unresolvedMethodArgs` onto
  // an already-built context during method execution. Not a new construction
  // site — inherits every field the factory populated.
  "src/domain/models/method_execution_service.ts",
]);

// Matches `: MethodContext = {` and `MethodContext = {` literal assignments.
const INLINE_LITERAL = /\bMethodContext\s*=\s*\{/;

Deno.test("architecture: no inline MethodContext literals outside factory and tests", async () => {
  const offenders: string[] = [];

  for await (
    const entry of walk(SRC_ROOT, {
      exts: [".ts"],
      includeDirs: false,
      followSymlinks: false,
    })
  ) {
    const rel = relative(REPO_ROOT, entry.path);
    if (rel.endsWith("_test.ts")) continue;
    if (ALLOWED_FILES.has(rel)) continue;

    const text = await Deno.readTextFile(entry.path);
    if (INLINE_LITERAL.test(text)) {
      offenders.push(rel);
    }
  }

  assertEquals(
    offenders,
    [],
    `Found inline MethodContext literals in production code:\n  ${
      offenders.join("\n  ")
    }\n\nRoute construction through buildMethodContext in src/domain/models/method_context.ts.`,
  );
});
