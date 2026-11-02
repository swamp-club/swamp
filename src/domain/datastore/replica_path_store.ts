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

export const MAX_FENCE = 10 ** FENCE_DIGITS - 1;

/**
 * a fence is always the 12-digit padded form core writes; nothing outside
 * <prefix>/_litestream/<fence>/ is ever listed or touched
 */
export interface ReplicaPathStore {
  /** a directory whose name is not a fence may be returned; swamp ignores it */
  list(signal: AbortSignal): Promise<string[]>;

  /**
   * resolves when nothing is there; throws, deleting nothing, when fence is not
   * the 12-digit padded form
   */
  removePath(fence: string, signal: AbortSignal): Promise<void>;
}

/** the reason never repeats the value */
export function replicaPathFenceProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "a fence must be a string";
  if (value.length !== FENCE_DIGITS || !/^[0-9]+$/.test(value)) {
    return `a fence must be exactly ${FENCE_DIGITS} digits`;
  }
  if (Number(value) < 1) return "a fence must be from 1";
  return undefined;
}

export function parseReplicaPathFence(name: string): number | undefined {
  return replicaPathFenceProblem(name) === undefined ? Number(name) : undefined;
}
