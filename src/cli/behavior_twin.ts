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
 * The `swamp model` twin of a `swamp behavior` command path
 * (swamp-club#3411).
 *
 * `swamp behavior …` (and its alias `swamp behaviour …`) has the same
 * commands as `swamp model …` with one difference in shape: there is no
 * `method` level, so `run`, `describe` and `history` sit directly under the
 * group. Every other word is the same in both trees.
 *
 * This module has no imports on purpose: telemetry and the auth gate can use
 * it without pulling in the command factories.
 */

/** The root words of the behavior group: its name and its alias. */
export const BEHAVIOR_GROUP_WORDS: readonly string[] = [
  "behavior",
  "behaviour",
];

/** The root word of the legacy group. */
export const MODEL_GROUP_WORD = "model";

/** The level `swamp model` has and `swamp behavior` does not. */
export const MODEL_METHOD_WORD = "method";

/**
 * The words that sit under `swamp model method` and directly under
 * `swamp behavior`.
 */
export const METHOD_LEVEL_WORDS: readonly string[] = [
  "run",
  "describe",
  "history",
];

/** Whether `word` is the root word of the behavior group. */
export function isBehaviorGroupWord(word: string | undefined): boolean {
  return word !== undefined && BEHAVIOR_GROUP_WORDS.includes(word);
}

/**
 * Whether the second word of a behavior path, as the canonical command name,
 * sits under the `method` level in the model tree.
 */
export function isMethodLevelWord(word: string | undefined): boolean {
  return word !== undefined && METHOD_LEVEL_WORDS.includes(word);
}

/**
 * The `swamp model` path that `path` stands for. `path` is a list of
 * canonical command names starting at the root, such as
 * `["behavior", "run"]`, which maps to `["model", "method", "run"]`, or
 * `["behavior", "type", "describe"]`, which maps to
 * `["model", "type", "describe"]`. A path outside the behavior group is
 * returned unchanged, as a copy.
 */
export function behaviorTwinPath(path: readonly string[]): string[] {
  if (!isBehaviorGroupWord(path[0])) return [...path];
  const rest = path.slice(1);
  return isMethodLevelWord(rest[0])
    ? [MODEL_GROUP_WORD, MODEL_METHOD_WORD, ...rest]
    : [MODEL_GROUP_WORD, ...rest];
}
