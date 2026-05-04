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

/*
 * Test helper for constructing an ExtensionRepository over an in-memory
 * SQLite catalog. Built first (per ADV-V3-1) so the loader-test cascade
 * caused by the (a-2) constructor migration is one mechanical pass:
 * every loader test that previously constructed `new
 * ExtensionCatalogStore(...)` now calls `makeStubRepository(...)`,
 * gets back both the repository and (for tests that still need the
 * catalog directly) the underlying catalog via `repo.legacyStore`.
 */

import { ExtensionCatalogStore } from "../extension_catalog_store.ts";
import { ExtensionRepository } from "../extension_repository.ts";

/**
 * Constructs an ExtensionRepository wrapping a fresh
 * {@link ExtensionCatalogStore}. The catalog uses the file path passed
 * in (callers create a temp dir / `:memory:` / a fixture file as
 * appropriate). Caller is responsible for closing the underlying
 * catalog via `repo.legacyStore.close()` at end-of-test.
 *
 * @param dbPath The catalog DB path. Use a tmpdir-relative path for
 *   isolation between tests, or `:memory:` for a fully in-memory
 *   SQLite instance.
 * @param repoRoot The canonical repo root the repository should use
 *   when resolving extensionRoot for pulled vs local origins.
 *   Defaults to a sentinel value tests can use unconditionally.
 * @param getLockedVersion Lockfile-fallback closure. Defaults to
 *   `() => null` (no lockfile entries available — orphan-DELETE
 *   semantics). Tests for the lockfile fallback override this.
 */
export function makeStubRepository(args: {
  dbPath: string;
  repoRoot?: string;
  getLockedVersion?: (name: string) => string | null;
}): { repository: ExtensionRepository; catalog: ExtensionCatalogStore } {
  const catalog = new ExtensionCatalogStore(args.dbPath);
  const repository = new ExtensionRepository({
    catalog,
    getLockedVersion: args.getLockedVersion ?? (() => null),
    repoRoot: args.repoRoot ?? "/test/repo",
  });
  return { repository, catalog };
}

/**
 * Synchronous convenience for tests that want a closure-style lockfile.
 * Pass a plain object mapping extension name to version; the returned
 * function looks up by name and returns null for misses.
 */
export function fixedLockedVersionLookup(
  versions: Readonly<Record<string, string>>,
): (name: string) => string | null {
  return (name) => versions[name] ?? null;
}
