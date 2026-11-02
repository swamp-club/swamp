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

// production MethodContext construction must go through buildMethodContext;
// this fails on a new inline literal outside the allowed files

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";

// Use fromFileUrl so Windows produces "D:\\..." instead of URL-pathname
// "/D:/..." which Deno.readDir cannot resolve on Windows.
const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  "src/domain/models/method_context.ts",
  "src/domain/models/model.ts",
  // Spread-based enrichment overlays `globalArgs`/`unresolvedMethodArgs` onto
  // an already-built context during method execution. Not a new construction
  // site — inherits every field the factory populated.
  "src/domain/models/method_execution_service.ts",
  // the worker builds a scratch-repo context proxying the orchestrator's data
  // plane; the local factory's startup-scoped deps do not exist on a worker
  "src/worker/remote_method_context.ts",
  // Test-only fixture builders. Not `_test.ts` themselves, but they exist
  // solely to fabricate a stub context for unit tests via
  // `{...} as unknown as MethodContext`. Production code must never do this.
  "src/domain/models/access/access_test_helpers.ts",
  "src/domain/models/worker/worker_test_helpers.ts",
]);

// the lookahead excludes indexed-access type references such as `as unknown as
// MethodContext["logger"]`, which name one field's type rather than fabricating
// a whole context
const INLINE_LITERAL =
  /\bMethodContext\s*=\s*\{|(?:satisfies|as)\s+MethodContext\b(?!\s*\[)/;

Deno.test("architecture: no inline MethodContext literals outside factory and tests", async () => {
  const offenders: string[] = [];

  for await (
    const entry of walk(SRC_ROOT, {
      exts: [".ts", ".tsx"],
      includeDirs: false,
      followSymlinks: false,
    })
  ) {
    // Normalize to forward slashes so the ALLOWED_FILES set (which uses
    // forward slashes) matches on Windows where `relative()` returns
    // backslash-separated paths.
    const rel = relative(REPO_ROOT, entry.path).replaceAll("\\", "/");
    if (/_test\.tsx?$/.test(rel)) continue;
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
