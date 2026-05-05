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

import {
  type ExtensionRef,
  type InstallContext,
  installExtension,
  type InstallResult,
} from "./pull.ts";

/**
 * W2 lifecycle service for installing a single extension. **Owns the
 * catalog write surface** end-to-end: filesystem mutations + lockfile
 * write + (commit 2c) Extension-aggregate construction +
 * `repository.save(extension)` with FS rollback on
 * `DuplicateTypeError`.
 *
 * **Asymmetric ordering with `RemoveExtensionService`.** Install is
 * filesystem → lockfile → catalog. Remove is the inverse (catalog →
 * lockfile → filesystem). Pinned in plan v4 challenge #3.
 *
 * **Snapshot semantics inherited from `InstallContext`.** The
 * `lockfileRepository` on the context captures a snapshot at
 * construction. Single-use only — see {@link InstallContext} JSDoc.
 *
 * **Current shape (commit 2b).** This is the service skeleton. It
 * delegates to the existing `installExtension` free function unchanged;
 * the architectural payoff (phase 8: synchronous type extraction +
 * `repository.save`) lands in commit 2c. Tests verify event-stream
 * byte-identicality across this skeleton refactor (Pin 2).
 */
export class InstallExtensionService {
  /**
   * Installs `ref` using `ctx`. Returns the {@link InstallResult} on a
   * fresh install, or `undefined` when the install short-circuited
   * (alreadyPulled). Throws `ConflictError` when files would be
   * overwritten and `ctx.force` is false. Recursively installs
   * dependencies via the same service instance (commit 2c will route
   * recursion through `this.execute` so phase 8 applies to each dep).
   */
  async execute(
    ref: ExtensionRef,
    ctx: InstallContext,
  ): Promise<InstallResult | undefined> {
    return await installExtension(ref, ctx);
  }
}
