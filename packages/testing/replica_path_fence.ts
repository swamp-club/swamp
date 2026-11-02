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

export const FENCE_DIGITS = 12;

/**
 * why value is not a padded fence: exactly 12 ASCII digits, from 000000000001.
 * Same rule as swamp's replica_path_store; change them together.
 */
export function replicaPathFenceProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "a fence must be a string";
  if (value.length !== FENCE_DIGITS || !/^[0-9]+$/.test(value)) {
    return `a fence must be exactly ${FENCE_DIGITS} digits`;
  }
  if (Number(value) < 1) return "a fence must be from 1";
  return undefined;
}
