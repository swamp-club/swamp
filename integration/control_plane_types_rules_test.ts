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
 * control-plane records are owned by the access kind and unreadable from
 * expressions, both keyed on CONTROL_PLANE_MODEL_TYPES; a swamp/* type left out
 * would store records a data:* grant reaches
 */

import { assertEquals } from "@std/assert";
import { relative } from "@std/path";
import {
  productionSourceFiles,
  SRC_DIR,
  toPosixPath,
} from "./arch_fitness_helpers.ts";
import { CONTROL_PLANE_MODEL_TYPES } from "../src/domain/models/control_plane_types.ts";
import { modelRegistry } from "../src/domain/models/models.ts";

/** Built-in swamp/* types that hold user data. None today. */
const USER_DATA_SWAMP_TYPES: readonly string[] = [];

const SWAMP_TYPE_DEFINITION = /ModelType\.create\(\s*["'](swamp\/[^"']+)["']/g;

Deno.test("control-plane types: every built-in swamp/* model type is in CONTROL_PLANE_MODEL_TYPES", async () => {
  const found: string[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(file);
    for (const match of source.matchAll(SWAMP_TYPE_DEFINITION)) {
      if (USER_DATA_SWAMP_TYPES.includes(match[1])) continue;
      if (!CONTROL_PLANE_MODEL_TYPES.includes(match[1])) {
        found.push(`${toPosixPath(relative(SRC_DIR, file))}: ${match[1]}`);
      }
    }
  }
  assertEquals(
    found,
    [],
    "These built-in swamp/* types are missing from CONTROL_PLANE_MODEL_TYPES",
  );
});

Deno.test("control-plane types: each listed type is defined by a built-in model", async () => {
  const defined = new Set<string>();
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(file);
    for (const match of source.matchAll(SWAMP_TYPE_DEFINITION)) {
      defined.add(match[1]);
    }
  }
  assertEquals(
    CONTROL_PLANE_MODEL_TYPES.filter((type) => !defined.has(type)),
    [],
  );
});

Deno.test("control-plane types: every registered built-in swamp/* type is in CONTROL_PLANE_MODEL_TYPES", () => {
  // The source scan above only sees literal type strings; the registry sees
  // every built-in type however it is defined.
  const missing = modelRegistry.types()
    .map((type) => type.normalized)
    .filter((type) => type.startsWith("swamp/"))
    .filter((type) =>
      !CONTROL_PLANE_MODEL_TYPES.includes(type) &&
      !USER_DATA_SWAMP_TYPES.includes(type)
    );
  assertEquals(missing, []);
});
