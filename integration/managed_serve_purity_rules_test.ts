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
import { join } from "@std/path";
import {
  extractImports,
  isCommentLine,
  isUnder,
  resolveImport,
  ROOT,
} from "./arch_fitness_helpers.ts";

// the supervisor's restart rules are tested without processes or a clock,
// which holds only while these files do no I/O and are handed the time
const PURE_FILES = ["src/domain/serve/managed_serve.ts"];

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["Deno API", /\bDeno\./],
  ["Date.now", /\bDate\.now\b/],
  ["new Date", /\bnew Date\b/],
  ["performance clock", /\bperformance\./],
  ["timer", /\b(?:setTimeout|setInterval)\b/],
  ["fetch", /\bfetch\s*\(/],
  ["WebSocket", /\bWebSocket\b/],
  ["dynamic import", /\bimport\s*\(/],
];

Deno.test("managed serve purity: the entity spawns nothing, opens no socket and reads no clock", async () => {
  const violations: string[] = [];
  for (const rel of PURE_FILES) {
    const path = join(ROOT, rel);
    const source = await Deno.readTextFile(path);
    source.split("\n").forEach((line, index) => {
      if (isCommentLine(line)) return;
      for (const [name, pattern] of FORBIDDEN) {
        if (pattern.test(line)) {
          violations.push(`${rel}:${index + 1} uses ${name}`);
        }
      }
    });
    for (const specifier of extractImports(source)) {
      const target = resolveImport(path, specifier);
      if (target === undefined || !isUnder(target, "src/domain")) {
        violations.push(`${rel} imports ${specifier} from outside src/domain`);
      }
    }
  }
  assertEquals(violations, []);
});
