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
 * The fence rule a `replicaPaths()` store applies, kept apart from the
 * conformance suite so the in-memory remote loads no assertion library.
 *
 * @module
 */

/** Digits a fence is padded to: the same width swamp writes. */
export const FENCE_DIGITS = 12;

/**
 * Why `value` is not a padded fence, or undefined when it is one: exactly
 * 12 ASCII digits, from `000000000001`. The same rule swamp applies
 * (`src/domain/datastore/replica_path_store.ts`), and
 * `replica_path_store_test.ts` there runs both over one fixture list:
 * change them together. A provider's `removePath` refuses what this
 * refuses.
 */
export function replicaPathFenceProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "a fence must be a string";
  if (value.length !== FENCE_DIGITS || !/^[0-9]+$/.test(value)) {
    return `a fence must be exactly ${FENCE_DIGITS} digits`;
  }
  if (Number(value) < 1) return "a fence must be from 1";
  return undefined;
}
