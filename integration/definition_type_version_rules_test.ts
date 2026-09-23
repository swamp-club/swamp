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

import {
  assertPinnedSet,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

/**
 * `typeVersion` records which model type version a definition's global
 * arguments were authored or migrated for. Creation and DefinitionUpgradeService
 * are the only things allowed to set it.
 *
 * The persistence layer used to stamp it on every save. That marked a stale
 * instance as current without migrating its arguments, and because
 * DefinitionUpgradeService short-circuits once typeVersion is at or above the
 * model version, the instance could never be migrated again (swamp-club#900).
 *
 * Removing that stamp means every `Definition.create` call site now owns the
 * field. A site that omits it produces a definition that records nothing about
 * which version its arguments were authored for, and the upgrade service
 * declines to migrate a definition in that state — so an upgrade shipped later
 * would silently pass it by (swamp-club#2412). A behavioural test would not
 * catch a regression here, because no first-party model that uses these paths
 * declares an upgrade chain — so the rule is pinned statically instead.
 */

/**
 * Call sites that deliberately construct a Definition without a typeVersion.
 * Add to this list only with a comment in the source explaining why.
 */
const PINNED_OMISSIONS: readonly string[] = [
  // Reconstructs a definition from the remote execution envelope to run one
  // method. Never persisted, and the upgrade chain does not run on this path —
  // only executeWorkflow upgrades, and it does so before dispatching.
  "src/worker/exec_dispatch.ts",
];

/** Matches `Definition.create({` and captures the object literal that follows. */
function findDefinitionCreateCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "Definition.create({";
  let index = source.indexOf(marker);
  while (index !== -1) {
    // Walk braces from the opening `{` to find the literal's extent.
    let depth = 0;
    let cursor = index + marker.length - 1;
    for (; cursor < source.length; cursor++) {
      const char = source[cursor];
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(index, cursor + 1));
    index = source.indexOf(marker, cursor);
  }
  return calls;
}

/**
 * Whether the object literal actually sets a `typeVersion` property. Comments
 * are stripped first: several of these call sites mention typeVersion in a
 * nearby comment explaining the rule, and a bare substring match would let a
 * regression through.
 */
function setsTypeVersion(call: string): boolean {
  const withoutComments = call
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return /\btypeVersion\s*(?::|,|\})/.test(withoutComments);
}

Deno.test("architecture: every Definition.create call site sets typeVersion", async () => {
  const omissions: string[] = [];

  for await (const filePath of productionSourceFiles(SRC_DIR)) {
    const source = await Deno.readTextFile(filePath);
    if (!source.includes("Definition.create({")) continue;

    for (const call of findDefinitionCreateCalls(source)) {
      if (!setsTypeVersion(call)) {
        omissions.push(repoRelative(filePath));
        break;
      }
    }
  }

  assertPinnedSet(
    omissions.sort(),
    PINNED_OMISSIONS,
    "Definition.create call sites omitting typeVersion",
    [
      "A definition created without a typeVersion records nothing about which",
      "version its arguments were authored for, so DefinitionUpgradeService will",
      "never migrate it and any upgrade shipped later passes it by.",
      "Pass the registered model's version, e.g. `typeVersion: grantModel.version`.",
      "If the definition is genuinely never persisted and never upgraded, add the",
      "file to PINNED_OMISSIONS with a comment in the source explaining why.",
    ].join("\n"),
  );
});
