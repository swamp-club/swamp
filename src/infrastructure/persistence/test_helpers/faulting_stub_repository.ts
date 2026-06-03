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

import type { Extension } from "../../../domain/extensions/extension.ts";
import { ExtensionRepository } from "../extension_repository.ts";
import type { ExtensionCatalogStore } from "../extension_catalog_store.ts";
import type { LockfileRepository } from "../lockfile_repository.ts";

/**
 * Fault-injection wrapper around an {@link ExtensionRepository}. Used by
 * crash-state recovery tests (W2 plan v4 step 10) to simulate a generic
 * non-`DuplicateTypeError` failure inside `saveAll` and verify that:
 *
 * - SQLite transaction rollback leaves the catalog in its pre-save
 *   state (no half-applied diff).
 * - The lifecycle service's caller-visible behavior is "throw, don't
 *   leave catalog half-written".
 * - Retrying the operation succeeds because the catalog is clean.
 *
 * Only `saveAll` (the only call site through which lifecycle services
 * mutate the catalog) is fault-injectable. Reads delegate unchanged.
 *
 * Subclasses {@link ExtensionRepository} so it slots into lifecycle
 * services without an interface refactor.
 */
export class FaultingStubRepository extends ExtensionRepository {
  private faultOnNextSaveAll: Error | null = null;

  constructor(args: {
    catalog: ExtensionCatalogStore;
    lockfileRepository: LockfileRepository;
    repoRoot: string;
  }) {
    super(args);
  }

  /** Schedules the next `saveAll` call to throw `error`. One-shot. */
  injectSaveAllFault(error: Error): void {
    this.faultOnNextSaveAll = error;
  }

  override saveAll(extensions: readonly Extension[]): void {
    if (this.faultOnNextSaveAll) {
      const err = this.faultOnNextSaveAll;
      this.faultOnNextSaveAll = null;
      throw err;
    }
    super.saveAll(extensions);
  }
}
