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
 * behavior has no method level, so run, describe and history sit directly under
 * the group; no imports on purpose, so telemetry and the auth gate can use it
 * without the command factories
 */

export const BEHAVIOR_GROUP_WORDS: readonly string[] = [
  "behavior",
  "behaviour",
];

export const MODEL_GROUP_WORD = "model";

export const MODEL_METHOD_WORD = "method";

export const METHOD_LEVEL_WORDS: readonly string[] = [
  "run",
  "describe",
  "history",
];

export function isBehaviorGroupWord(word: string | undefined): boolean {
  return word !== undefined && BEHAVIOR_GROUP_WORDS.includes(word);
}

export function isMethodLevelWord(word: string | undefined): boolean {
  return word !== undefined && METHOD_LEVEL_WORDS.includes(word);
}

/**
 * the model path that `path` (canonical names from the root) stands for, e.g.
 * [behavior, run] maps to [model, method, run]; a path outside the behavior
 * group is returned unchanged, as a copy.
 */
export function behaviorTwinPath(path: readonly string[]): string[] {
  if (!isBehaviorGroupWord(path[0])) return [...path];
  const rest = path.slice(1);
  return isMethodLevelWord(rest[0])
    ? [MODEL_GROUP_WORD, MODEL_METHOD_WORD, ...rest]
    : [MODEL_GROUP_WORD, ...rest];
}
