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

// Architectural fitness test: a namespace can never take a name swamp itself
// uses in a checkout's `.swamp/` (swamp-club#3691).
//
// A v3 checkout materialises a namespace's records at `.swamp/{namespace}/`.
// A namespace named after a directory swamp keeps there (`vault`,
// `definitions`, `datastore-bundles`, ...) would have other checkouts'
// commits written over swamp's own files. The reserved list lives in the
// domain (`SWAMP_OWNED_DIR_NAMES`, so the namespace rules need no
// infrastructure import); this test fails when swamp starts using a
// first-level `.swamp/` name the list does not hold:
//
// 1. every first segment of `SWAMP_SUBDIRS` is reserved;
// 2. every first-level name in a `.swamp/` path literal in production code is
//    reserved, when it could be a namespace at all: `join(…, ".swamp", "x")`,
//    `swampPath(repoDir, "x")`, `join(…, SWAMP_DATA_DIR, "x")`,
//    `` `${SWAMP_DATA_DIR}/x` `` and `join(getSwampDataDir(), "x")` (the home
//    `.swamp/`, which is a checkout's when the repository is the home
//    directory).
//
// The scan is textual: a name built at runtime gets past it. The pin on the
// scanned names proves the patterns still match.

import { assert, assertEquals } from "@std/assert";
import {
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import {
  isReservedNamespaceName,
  RESERVED_NAMESPACE_NAMES,
} from "../src/domain/data/namespace.ts";

/** The shape `createNamespace` accepts, without the length bound. */
const NAMESPACE_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** First-level `.swamp/` names in path literals, by the name's capture. */
const SWAMP_DIR_LITERALS: readonly RegExp[] = [
  /\bjoin\((?:[^;()]|\([^()]*\))*?"\.swamp"\s*,\s*"([^"]+)"/g,
  /\bswampPath\(\s*[^,()]+,\s*"([^"]+)"/g,
  /\bSWAMP_DATA_DIR\s*,\s*"([^"]+)"/g,
  /\$\{SWAMP_DATA_DIR\}\/([a-z0-9][a-z0-9-]*)/g,
  /\bgetSwampDataDir\(\)\s*,\s*"([^"]+)"/g,
];

/**
 * First-level `.swamp/` names passed as a named constant, by the constant's
 * capture: `swampPath(repoDir, PRE_V3_RECORDS_DIR)`.
 */
const SWAMP_DIR_CONSTANTS: readonly RegExp[] = [
  /\bswampPath\(\s*[^,()]+,\s*([A-Z][A-Z0-9_]*)\s*[,)]/g,
  /\bjoin\((?:[^;()]|\([^()]*\))*?"\.swamp"\s*,\s*([A-Z][A-Z0-9_]*)\s*[,)]/g,
];

/** A string constant's declaration: `const NAME = "value"`. */
const STRING_CONSTANT =
  /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*"([^"]+)"/g;

/** Each scanned name with the files that use it. */
async function scannedSwampDirNames(): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  const add = (name: string, file: string) => {
    const files = names.get(name.split("/")[0]) ?? [];
    files.push(repoRelative(file));
    names.set(name.split("/")[0], files);
  };
  const constants = new Map<string, string>();
  const byConstant: { constant: string; file: string }[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(file);
    for (const pattern of SWAMP_DIR_LITERALS) {
      for (const match of source.matchAll(pattern)) add(match[1], file);
    }
    for (const match of source.matchAll(STRING_CONSTANT)) {
      constants.set(match[1], match[2]);
    }
    for (const pattern of SWAMP_DIR_CONSTANTS) {
      for (const match of source.matchAll(pattern)) {
        byConstant.push({ constant: match[1], file });
      }
    }
  }
  for (const { constant, file } of byConstant) {
    const value = constants.get(constant);
    if (value !== undefined) add(value, file);
  }
  return names;
}

Deno.test("fitness: every SWAMP_SUBDIRS directory is a reserved namespace name", () => {
  const missing = Object.values(SWAMP_SUBDIRS)
    .map((subdir) => subdir.split("/")[0])
    .filter((name) => !isReservedNamespaceName(name));
  assertEquals(
    [...new Set(missing)],
    [],
    "Add these to SWAMP_OWNED_DIR_NAMES in " +
      "src/domain/datastore/datastore_config.ts: a namespace named after one " +
      "would be materialised over swamp's own files in .swamp/.",
  );
});

Deno.test("fitness: every .swamp/ name in a path literal is a reserved namespace name", async () => {
  const scanned = await scannedSwampDirNames();
  // The patterns still match what the source spells out.
  for (
    const known of [
      "cache",
      "start",
      "config",
      "pulled-extensions",
      "pre-v3-records",
    ]
  ) {
    assert(scanned.has(known), `the scan no longer finds .swamp/${known}`);
  }
  const unreserved = [...scanned]
    .filter(([name]) =>
      NAMESPACE_SHAPE.test(name) && !RESERVED_NAMESPACE_NAMES.has(name)
    )
    .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
  assertEquals(
    unreserved,
    [],
    "Swamp uses these .swamp/ names, but a namespace may still take them. " +
      "Add them to SWAMP_OWNED_DIR_NAMES in " +
      "src/domain/datastore/datastore_config.ts.",
  );
});
