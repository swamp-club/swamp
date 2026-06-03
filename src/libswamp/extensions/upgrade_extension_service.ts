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

import type { ExtensionRef, InstallContext, InstallResult } from "./pull.ts";
import { InstallExtensionService } from "./install_extension_service.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";

/**
 * W2 lifecycle service for upgrading an installed extension to a new
 * version. **Atomic transition** — `saveAll([tombstoneAll(vN), vN+1])`
 * commits in one SQLite transaction so I-Repo-1 evaluates only the
 * post-save state where vN+1 holds the type identifier.
 *
 * **Implementation note.** {@link InstallExtensionService.execute}
 * already implements the atomic pattern internally — for every new
 * version it tombstones any existing aggregates with the same name
 * but a different version BEFORE calling `repository.saveAll`. So
 * upgrade is structurally `install` of the new version; this class is
 * a thin discoverable facade so callers that mean "upgrade" can express
 * the intent at the call site.
 *
 * **Bulk-upgrade behavior** (resolves plan v4 challenge ADV-5). Each
 * upgrade is its own atomic transition via its own `saveAll`. If A's
 * upgrade rolls back due to a collision with unchanged B, every other
 * extension already-upgraded in the bulk run STAYS upgraded — there is
 * no all-or-nothing rollback across a bulk-upgrade run. Pinned by
 * design.
 *
 * **Recovery posture for upgrade-half-state.** If `repository.save`
 * rolls back via `DuplicateTypeError`, the install service's FS
 * rollback fires (delete v2 files, restore lockfile entry to v1).
 * Plan v4 step 11 pins the user-visible recovery message:
 *
 *   "Upgrade partially applied. Run `swamp doctor extensions` to
 *   inspect, or `swamp extension rm <name> && swamp extension pull
 *   <name>@<version>` to reconcile."
 *
 * (The recovery message lands with the UserError mapping in commit 6.)
 */
export class UpgradeExtensionService {
  private readonly installService: InstallExtensionService;

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    /**
     * Test seam — defaults to the real `installExtension` from
     * `pull.ts`. Tests inject a stub when exercising upgrade against
     * a pre-staged on-disk subtree.
     */
    installExtensionFn?: (
      ref: ExtensionRef,
      ctx: InstallContext,
    ) => Promise<InstallResult | undefined>;
  }) {
    this.installService = new InstallExtensionService(args);
  }

  /**
   * Upgrades extension `name` to `newVersion`. Drives the same
   * filesystem + lockfile + catalog flow as install; the atomic
   * tombstone of the prior version happens inside the install
   * service's phase 8.
   */
  async execute(
    name: string,
    newVersion: string,
    ctx: InstallContext,
  ): Promise<InstallResult | undefined> {
    return await this.installService.execute(
      { name, version: newVersion },
      ctx,
    );
  }
}
