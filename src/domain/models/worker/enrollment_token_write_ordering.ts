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

import type { ModelType } from "../model_type.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "./enrollment_token_model.ts";

/** runs fn in order with every other write to enrollment-token records */
export type EnrollmentTokenWriteOrdering = <T>(
  fn: () => Promise<T>,
) => Promise<T>;

let activeOrdering: EnrollmentTokenWriteOrdering | null = null;

/** set by the process that owns the token records' writer; null clears it */
export function setEnrollmentTokenWriteOrdering(
  ordering: EnrollmentTokenWriteOrdering | null,
): void {
  activeOrdering = ordering;
}

export function isEnrollmentTokenType(modelType: ModelType): boolean {
  return modelType.normalized === ENROLLMENT_TOKEN_MODEL_TYPE.normalized;
}

/**
 * fn reads and rewrites a record of modelType; a token record's run goes
 * through the registered ordering, and is dropped if signal aborted while it
 * waited; anything else runs as is
 */
export function orderEnrollmentTokenWrite<T>(
  modelType: ModelType,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const ordering = activeOrdering;
  if (ordering === null || !isEnrollmentTokenType(modelType)) return fn();
  return ordering(() => {
    signal?.throwIfAborted();
    return fn();
  });
}
