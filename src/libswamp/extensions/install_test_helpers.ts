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

import type {
  ExtensionRef,
  InstallContext,
  InstallExtensionFn,
  InstallResult,
} from "./pull.ts";

/**
 * Wraps a stub install as an {@link InstallExtensionFn} test seam for
 * InstallExtensionService. The real installExtension runs the service's
 * phase 8 through `options.underLock`; a stub that skipped it would
 * leave phase 8 untested without any error. The prior entry is read
 * before the stub runs, as installExtension reads it before apply.
 */
export function stubInstallExtension(
  install: (
    ref: ExtensionRef,
    ctx: InstallContext,
  ) => Promise<InstallResult | undefined>,
): InstallExtensionFn {
  return async (ref, ctx, options) => {
    const priorEntry = ctx.lockfileRepository.getEntry(ref.name);
    const result = await install(ref, ctx);
    if (result) await options?.underLock?.({ result, priorEntry });
    return result;
  };
}
