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
 * catalog directly) the underlying catalog via `repo.getCatalogStore()`.
 */

import { ExtensionCatalogStore } from "../extension_catalog_store.ts";
import { ExtensionRepository } from "../extension_repository.ts";
import type { LocalManifestIdentity } from "../local_manifest_reader.ts";
import { LockfileRepository } from "../lockfile_repository.ts";
import type { UpstreamExtensionsMap } from "../upstream_extensions.ts";

/**
 * Constructs an ExtensionRepository wrapping a fresh
 * {@link ExtensionCatalogStore}. The catalog uses the file path passed
 * in (callers create a temp dir / `:memory:` / a fixture file as
 * appropriate). Caller is responsible for closing the underlying
 * catalog via `repo.close()` at end-of-test.
 *
 * @param dbPath The catalog DB path. Use a tmpdir-relative path for
 *   isolation between tests, or `:memory:` for a fully in-memory
 *   SQLite instance.
 * @param repoRoot The canonical repo root the repository should use
 *   when resolving extensionRoot for pulled vs local origins.
 *   Defaults to a sentinel value tests can use unconditionally.
 * @param lockedVersions Lockfile-fallback fixture map keyed by
 *   extension name. Defaults to `{}` (no lockfile entries available —
 *   orphan-DELETE semantics). Tests for the lockfile fallback override
 *   this. Internally constructed into a {@link LockfileRepository}
 *   with a sentinel path so reads serve from the in-memory cache.
 */
export function makeStubRepository(args: {
  dbPath: string;
  repoRoot?: string;
  lockedVersions?: UpstreamExtensionsMap;
  localManifestIdentity?: LocalManifestIdentity | null;
}): { repository: ExtensionRepository; catalog: ExtensionCatalogStore } {
  const catalog = new ExtensionCatalogStore(args.dbPath);
  const lockfileRepository = new LockfileRepository(
    "/test/repo/upstream_extensions.json",
    args.lockedVersions ?? {},
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: args.repoRoot ?? "/test/repo",
    localManifestIdentity: args.localManifestIdentity,
  });
  return { repository, catalog };
}

/**
 * Synchronous convenience for tests that want a fixture lockfile keyed
 * by name → version. Maps the name→version object into the full
 * UpstreamExtensionsMap shape (synthesizing a placeholder pulledAt) so
 * callers don't have to spell out the full entry shape per test.
 */
export function fixedLockedVersions(
  versions: Readonly<Record<string, string>>,
): UpstreamExtensionsMap {
  const map: UpstreamExtensionsMap = {};
  for (const [name, version] of Object.entries(versions)) {
    map[name] = {
      version,
      pulledAt: "1970-01-01T00:00:00.000Z",
    };
  }
  return map;
}
