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

// a namespace must never take a name swamp itself uses in a checkout's .swamp/,
// or commits would overwrite swamp's own files; the scan is textual, so a name
// built at runtime gets past it

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

const NAMESPACE_SHAPE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const SWAMP_DIR_LITERALS: readonly RegExp[] = [
  /\bjoin\((?:[^;()]|\([^()]*\))*?"\.swamp"\s*,\s*"([^"]+)"/g,
  /\bswampPath\(\s*[^,()]+,\s*"([^"]+)"/g,
  /\bSWAMP_DATA_DIR\s*,\s*"([^"]+)"/g,
  /\$\{SWAMP_DATA_DIR\}\/([a-z0-9][a-z0-9-]*)/g,
  /\bgetSwampDataDir\(\)\s*,\s*"([^"]+)"/g,
];

const SWAMP_DIR_CONSTANTS: readonly RegExp[] = [
  /\bswampPath\(\s*[^,()]+,\s*([A-Z][A-Z0-9_]*)\s*[,)]/g,
  /\bjoin\((?:[^;()]|\([^()]*\))*?"\.swamp"\s*,\s*([A-Z][A-Z0-9_]*)\s*[,)]/g,
];

const STRING_CONSTANT =
  /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*"([^"]+)"/g;

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
