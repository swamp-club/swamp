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
import { relative } from "@std/path";
import {
  productionSourceFiles,
  ROOT,
  SRC_DIR,
  toPosixPath,
} from "./arch_fitness_helpers.ts";

const LOG_TEMPLATE =
  /\.(?:trace|debug|info|warn|warning|error|fatal)`((?:[^`\\]|\\.)*)`/gs;
const QUOTED_INTERPOLATION = /(['"])\$\{[^}]*\}\1/;

Deno.test("logtape templates: no interpolation is wrapped in literal quotes", async () => {
  const offenders: string[] = [];
  for await (const path of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(path);
    for (const match of source.matchAll(LOG_TEMPLATE)) {
      if (QUOTED_INTERPOLATION.test(match[1])) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${toPosixPath(relative(ROOT, path))}:${line}`);
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "a LogTape template wraps an interpolated value in literal quotes. The " +
      "formatter already quotes strings, so the value prints doubled; " +
      "interpolate it bare.",
  );
});
