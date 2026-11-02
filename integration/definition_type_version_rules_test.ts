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
 * only creation and DefinitionUpgradeService set typeVersion; a
 * Definition.create site omitting it is skipped by later upgrades, and no
 * behavioural test would catch that, so the rule is pinned statically
 */

/**
 * call sites that deliberately construct a Definition without a typeVersion;
 * add one only with a source comment explaining why
 */
const PINNED_OMISSIONS: readonly string[] = [];

function findDefinitionCreateCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = "Definition.create({";
  let index = source.indexOf(marker);
  while (index !== -1) {
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
 * comments are stripped first: call sites mention typeVersion in nearby
 * comments, and a bare substring match would let a regression through
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
