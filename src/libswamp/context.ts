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

import type { Logger } from "@logtape/logtape";
import type { UnitOfWork } from "../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { createLegacyUnitOfWork } from "../infrastructure/persistence/legacy_unit_of_work.ts";

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
  /**
   * Opens a fresh unit of work for one operation. Write use cases call it
   * through `withUnitOfWork`; nothing else should.
   */
  openUnitOfWork(): UnitOfWork;
  /** Create a child context that cancels after the given duration. */
  withTimeout(ms: number): LibSwampContext;
  /** Create a child context that cancels when either this context or the given signal aborts. */
  withSignal(signal: AbortSignal): LibSwampContext;
}

/**
 * Opens a unit of work bound to no mark hook: it records staged changes and
 * sends nothing. No repository stages into it, so a context built without a
 * factory behaves exactly as before units of work existed.
 */
function openUnboundUnitOfWork(): UnitOfWork {
  return createLegacyUnitOfWork(undefined, { flush: undefined });
}

export function createLibSwampContext(
  options?: {
    signal?: AbortSignal;
    logger?: Logger;
    /**
     * Opens the unit of work for each write use case. Composition roots that
     * hold a repository context pass one bound to that context's mark hook
     * (`repoUnitOfWorkFactory` in
     * `src/infrastructure/persistence/repo_unit_of_work.ts`). Child contexts
     * keep it.
     */
    openUnitOfWork?: () => UnitOfWork;
  },
): LibSwampContext {
  const signal = options?.signal ?? new AbortController().signal;
  const logger = options?.logger ?? getSwampLogger(["libswamp"]);
  const openUnitOfWork = options?.openUnitOfWork ?? openUnboundUnitOfWork;
  return {
    signal,
    logger,
    openUnitOfWork,
    withTimeout(ms: number): LibSwampContext {
      return createLibSwampContext({
        signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
        logger,
        openUnitOfWork,
      });
    },
    withSignal(other: AbortSignal): LibSwampContext {
      return createLibSwampContext({
        signal: AbortSignal.any([signal, other]),
        logger,
        openUnitOfWork,
      });
    },
  };
}
