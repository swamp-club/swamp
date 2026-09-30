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
 * Architecture fitness rule: every built-in `swamp/*` model type is a
 * control-plane type (swamp-club#2756).
 *
 * Control-plane records (grants, groups, tokens, workers, leases) are owned
 * by the `access` kind when served and are unreadable from expressions, and
 * both rules key on CONTROL_PLANE_MODEL_TYPES. A new built-in `swamp/*` type
 * that is left out of the list would store its records as plain data that a
 * `data:*` read grant reaches. Add it to the list, or — if it truly holds
 * user data — pin it below with the reason.
 */

import { assertEquals } from "@std/assert";
import { relative } from "@std/path";
import {
  productionSourceFiles,
  SRC_DIR,
  toPosixPath,
} from "./arch_fitness_helpers.ts";
import { CONTROL_PLANE_MODEL_TYPES } from "../src/domain/models/control_plane_types.ts";

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
