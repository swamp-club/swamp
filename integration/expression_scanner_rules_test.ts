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

/**
 * no production regex may match the ${{ opener unless pinned: one ending at the
 * first }}, even inside a CEL string, disagrees with the scanner and silently
 * turns an authored expression into literal text
 */

import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const OPENER_IN_REGEX = "\\$\\{\\{";

/**
 * Regexes allowed to match the opener, each with the reason its boundary
 * cannot disagree with the scanner's.
 */
const PINNED: readonly string[] = [
  // Matches only the canonical vault reference swamp itself writes, anchored
  // at both ends, with no `}}` possible inside it.
  "src/domain/models/data_writer.ts: /^\\$\\{\\{\\s*vault\\.get\\(\\s*'([^']+)'\\s*,\\s*'([^']+)'\\s*\\)\\s*\\}\\}$/;",
  // Detection only: whether a string holds an expression at all, which does
  // not depend on which `}}` ends it.
  "src/domain/expressions/expression_parser.ts: const HAS_EXPRESSION_PATTERN = /\\$\\{\\{.+?\\}\\}/s;",
  // Anchored at both ends, so a `}}` inside a string stays in the capture.
  "src/domain/expressions/expression_parser.ts: const match = raw.match(/^\\$\\{\\{\\s*(.+?)\\s*\\}\\}\\s*$/s);",
  // Anchored at both ends; validates the shape of a whole-value target.
  "src/domain/workflows/step_task.ts: const EXPRESSION_PATTERN = /^\\$\\{\\{\\s*.+?\\s*\\}\\}\\s*$/s;",
  // Finds openers for unclosed-expression reporting; spans come from the
  // scanner.
  "src/domain/models/template_syntax_scan.ts: const EXPRESSION_OPENER = /\\$\\{\\{/g;",
  // Anchored at both ends; flags an assert expression wrapped in `${{ }}`.
  "src/domain/workflows/validation_service.ts: const exprPattern = /^\\$\\{\\{.*\\}\\}\\s*$/s;",
];

async function findOpenerRegexes(): Promise<string[]> {
  const hits: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    if (!source.includes(OPENER_IN_REGEX)) continue;
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (line.includes(OPENER_IN_REGEX)) {
        hits.push(`${repoRelative(filePath)}: ${trimmed}`);
      }
    }
  }
  return hits.sort();
}

Deno.test("expression scanner: no new regex finds ${{ ... }} expressions", async () => {
  assertPinnedSet(
    await findOpenerRegexes(),
    PINNED,
    "Regexes matching the ${{ opener",
    "Find expressions with the shared scanner in " +
      "src/domain/expressions/expression_scanner.ts instead: a regex ends an " +
      "expression at the first }}, even inside a CEL string, and its raw text " +
      "then disagrees with every other pass. If the regex cannot disagree " +
      "(it is anchored at both ends, or only detects), pin it with the reason.",
  );
});
