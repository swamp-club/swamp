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

import type { InstallRollbackOutcome } from "../../domain/extensions/duplicate_type_user_error.ts";
import type {
  ExtensionRef,
  InstallContext,
  InstallExtensionFn,
  InstallResult,
  PendingInstall,
} from "./pull.ts";

/** What phase 8 did with the stub's install. */
export interface StubPendingCalls {
  commit: number;
  rollback: number;
}

/**
 * Wraps a stub install as an {@link InstallExtensionFn} test seam for
 * InstallExtensionService. The real installExtension runs the service's
 * phase 8 through `options.underLock`; a stub that skipped it would
 * leave phase 8 untested without any error.
 *
 * Phase 8 receives a fake {@link PendingInstall} that records which of
 * commit and rollback it called in `calls` (the first call only, as the
 * real handle ignores later ones) and answers rollback with `rollback`.
 * It moves nothing: what a real commit and rollback do on disk is
 * tested against the real installExtension. Unlike installExtension,
 * the stub does not commit an install phase 8 left pending, so a test
 * sees exactly what the service chose.
 */
export function stubInstallExtension(
  install: (
    ref: ExtensionRef,
    ctx: InstallContext,
  ) => Promise<InstallResult | undefined>,
  options: {
    calls?: StubPendingCalls;
    rollback?: InstallRollbackOutcome;
  } = {},
): InstallExtensionFn {
  const calls = options.calls ?? { commit: 0, rollback: 0 };
  const outcome = options.rollback ?? { status: "rolled-back" };
  return async (ref, ctx, installOptions) => {
    const result = await install(ref, ctx);
    if (!result) return result;
    let ended = false;
    const pending: PendingInstall = {
      result,
      commit: () => {
        if (!ended) {
          ended = true;
          calls.commit++;
        }
        return Promise.resolve();
      },
      rollback: () => {
        if (!ended) {
          ended = true;
          calls.rollback++;
        }
        return Promise.resolve(outcome);
      },
    };
    await installOptions?.underLock?.(pending);
    return result;
  };
}
