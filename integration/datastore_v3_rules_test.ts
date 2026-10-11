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
 * Fitness rules for the v3 datastore domain model (swamp-club#3233).
 *
 * 1. **Dormancy.** The model in `src/domain/datastore/v3/` is built ahead of
 *    the commit store, chunk store and opt-in that will use it. Until then no
 *    production code outside it may import it, so it cannot change
 *    behaviour. That covers `src/cli`, `src/serve`, `src/libswamp` and the
 *    `src/domain/datastore/mod.ts` barrel. The pinned list is empty; the
 *    issue that wires the model in adds its edges here.
 * 2. **Partition keys come from aggregate identity.** `partitionOf()` is the
 *    only way to build a key. No string or template literal elsewhere may
 *    start with a partition-key prefix, so nobody assembles a key by hand.
 */

import {
  assertPinnedSet,
  collectImportEdges,
  importsLayer,
  isUnder,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const V3_DIR = "src/domain/datastore/v3";

/** The production imports of the v3 model from outside it. */
const PINNED_V3_IMPORTERS: readonly string[] = [];

Deno.test("datastore v3: no production code outside the model imports it", async () => {
  const edges = await collectImportEdges(
    SRC_DIR,
    (filePath, importPath) =>
      importsLayer(filePath, importPath, "domain/datastore/v3") &&
      !isUnder(repoRelative(filePath), V3_DIR),
  );
  assertPinnedSet(
    edges,
    PINNED_V3_IMPORTERS,
    "Production imports of the dormant v3 datastore model",
    "The v3 model is dormant until the commit-store issue wires it in. Do not\n" +
      "import it from production code before then.",
  );
});

/** A string or template literal that starts with a partition-key prefix. */
const HAND_BUILT_KEY = /["'`](?:model|run|config|definition)--/;

/** The one file allowed to spell partition keys. */
const KEY_BUILDER = `${V3_DIR}/partition_key.ts`;

/** Hand-built partition keys outside `partition_key.ts`, as `file:line`. */
const PINNED_HAND_BUILT_KEYS: readonly string[] = [];

Deno.test("datastore v3: partition keys are built only by partitionOf()", async () => {
  const found: string[] = [];
  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const rel = repoRelative(filePath);
    if (rel === KEY_BUILDER) continue;
    const lines = (await Deno.readTextFile(filePath)).split("\n");
    lines.forEach((line, index) => {
      if (HAND_BUILT_KEY.test(line)) found.push(`${rel}:${index + 1}`);
    });
  }
  assertPinnedSet(
    found.sort(),
    PINNED_HAND_BUILT_KEYS,
    "Hand-built partition keys",
    "Build partition keys with partitionOf() from the aggregate's identity\n" +
      `(${KEY_BUILDER}), not by hand.`,
  );
});
