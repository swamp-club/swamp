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

// Architecture guard: production MethodReportContext construction must go
// through buildMethodReportContext. This test walks src/ and fails if a new
// inline MethodReportContext object literal appears outside the allowed files.
// If this test fails, route the construction through buildMethodReportContext
// in src/domain/reports/report_context.ts.

import { assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { fromFileUrl, join, relative } from "@std/path";

// Use fromFileUrl so Windows produces "D:\\..." instead of URL-pathname
// "/D:/..." which Deno.readDir cannot resolve on Windows.
const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  // The factory itself.
  "src/domain/reports/report_context.ts",
]);

// Matches the three ways a MethodReportContext gets constructed outside the
// factory: `MethodReportContext = {` object literals, `satisfies
// MethodReportContext`, and `as (unknown as) MethodReportContext` casts.
// The negative lookahead excludes indexed-access *type* references such as
// `as unknown as MethodReportContext["logger"]`, which name one field's type
// rather than fabricating a whole context.
const INLINE_LITERAL =
  /\bMethodReportContext\s*=\s*\{|(?:satisfies|as)\s+MethodReportContext\b(?!\s*\[)/;

Deno.test("architecture: no inline MethodReportContext literals outside factory and tests", async () => {
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
    `Found inline MethodReportContext literals in production code:\n  ${
      offenders.join("\n  ")
    }\n\nRoute construction through buildMethodReportContext in src/domain/reports/report_context.ts.`,
  );
});
