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

import { ExtensionCatalogStore } from "../extension_catalog_store.ts";
import { ExtensionRepository } from "../extension_repository.ts";
import type { LocalManifestIdentity } from "../local_manifest_reader.ts";
import { LockfileRepository } from "../lockfile_repository.ts";
import type { UpstreamExtensionsMap } from "../upstream_extensions.ts";

/**
 * the caller closes the catalog with repo.close(); sourceExists defaults to
 * always because fixtures use fictitious source paths
 */
export function makeStubRepository(args: {
  dbPath: string;
  repoRoot?: string;
  lockedVersions?: UpstreamExtensionsMap;
  localManifestIdentity?: LocalManifestIdentity | null;
  sourceExists?: (sourcePath: string) => boolean;
  activePulledRoot?: () => string | undefined;
  mountedSourceDirs?: readonly string[];
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
    sourceExists: args.sourceExists ?? (() => true),
    activePulledRoot: args.activePulledRoot ?? (() => undefined),
    mountedSourceDirs: args.mountedSourceDirs ?? [],
  });
  return { repository, catalog };
}

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
