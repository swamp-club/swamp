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

export interface StubPendingCalls {
  commit: number;
  rollback: number;
}

/**
 * a stub that skipped options.underLock would leave phase 8 untested without
 * any error; the fake PendingInstall records only the first call, as the real
 * handle ignores later ones, and moves nothing
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
