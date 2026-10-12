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

import { UserError } from "../errors.ts";

/** The home workspace `swamp start` uses when none is named. */
export const DEFAULT_WORKSPACE_NAME = "first-workspace";

const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Validates a workspace name: one path segment of lowercase letters, digits and dashes. */
export function parseWorkspaceName(name: string): string {
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new UserError(
      `Invalid workspace name "${name}". Use lowercase letters, digits and dashes, starting with a letter or digit (at most 63 characters).`,
    );
  }
  return name;
}

const NAME_ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "clever",
  "crisp",
  "dappled",
  "deep",
  "dusky",
  "eager",
  "gentle",
  "glassy",
  "golden",
  "hazy",
  "hidden",
  "humble",
  "jolly",
  "keen",
  "lively",
  "lucky",
  "mellow",
  "misty",
  "mossy",
  "nimble",
  "patient",
  "quiet",
  "rapid",
  "shady",
  "silver",
  "steady",
  "still",
  "sunny",
  "swift",
  "tidy",
  "velvet",
  "warm",
  "wily",
] as const;

const NAME_CREATURES = [
  "alligator",
  "beaver",
  "bittern",
  "bullfrog",
  "caiman",
  "crane",
  "cypress",
  "dragonfly",
  "egret",
  "firefly",
  "heron",
  "ibis",
  "kingfisher",
  "lily",
  "mink",
  "moorhen",
  "muskrat",
  "newt",
  "otter",
  "pelican",
  "reed",
  "salamander",
  "sedge",
  "snapper",
  "spoonbill",
  "tadpole",
  "teal",
  "terrapin",
  "toad",
  "turtle",
  "water-lily",
  "willow",
] as const;

/**
 * Suggests a workspace name such as `misty-heron`, avoiding the names in
 * `taken`. A clash after a few draws gets a numeric suffix, so a name is
 * always returned. `random` returns values in [0, 1).
 */
export function suggestWorkspaceName(
  taken: ReadonlySet<string>,
  random: () => number = Math.random,
): string {
  const pick = <T>(list: readonly T[]): T =>
    list.at(Math.floor(random() * list.length) % list.length) as T;
  let base = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    base = `${pick(NAME_ADJECTIVES)}-${pick(NAME_CREATURES)}`;
    if (!taken.has(base)) return base;
  }
  for (let n = 2;; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
