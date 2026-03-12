// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { Logger } from "@logtape/logtape";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

/**
 * Cross-cutting concern carrier for libswamp operations.
 * Carries cancellation signals and scoped metadata, following
 * the same pattern as Go's context.Context.
 */
export interface LibSwampContext {
  /** Cancellation signal. Abort to cancel the operation and all its children. */
  readonly signal: AbortSignal;
  /** Scoped logger for this operation. */
  readonly logger: Logger;
  /** Create a child context that cancels after the given duration. */
  withTimeout(ms: number): LibSwampContext;
  /** Create a child context that cancels when either this context or the given signal aborts. */
  withSignal(signal: AbortSignal): LibSwampContext;
}

export function createLibSwampContext(
  options?: { signal?: AbortSignal; logger?: Logger },
): LibSwampContext {
  const signal = options?.signal ?? new AbortController().signal;
  const logger = options?.logger ?? getSwampLogger(["libswamp"]);
  return {
    signal,
    logger,
    withTimeout(ms: number): LibSwampContext {
      return createLibSwampContext({
        signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
        logger,
      });
    },
    withSignal(other: AbortSignal): LibSwampContext {
      return createLibSwampContext({
        signal: AbortSignal.any([signal, other]),
        logger,
      });
    },
  };
}
