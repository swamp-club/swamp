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

/**
 * which pulled extension at which version a loaded datastore type came from, so
 * a v3 bucket datastore can refuse an extension older than the release it needs
 */

import { dirname, isAbsolute, join, relative, SEPARATOR } from "@std/path";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import {
  V3_BUCKET_MIN_EXTENSION_VERSION,
  V3BucketExtensionTooOldError,
} from "../../domain/datastore/v3_hosting.ts";
import { CalVer } from "../../domain/models/calver.ts";
import { canonicalizePath, realCanonicalPath } from "./canonicalize_path.ts";
import {
  type LocalManifestIdentity,
  readManifestIdentityAt,
} from "./local_manifest_reader.ts";
import { LockfileRepository } from "./lockfile_repository.ts";
import { swampPath } from "./paths.ts";

/**
 * an unknown version, or one that isn't a published calendar version (local or
 * mounted source), passes; the capability check still runs for it
 */
export function assertV3BucketExtensionVersion(
  version: string | undefined,
  datastoreType: string,
  where = "its extension is",
  extensionName: string = datastoreType,
): void {
  if (version === undefined || !CalVer.isValid(version)) return;
  const minimum = CalVer.create(V3_BUCKET_MIN_EXTENSION_VERSION);
  if (CalVer.compare(CalVer.create(version), minimum) < 0) {
    throw new V3BucketExtensionTooOldError(
      datastoreType,
      version,
      where,
      extensionName,
    );
  }
}

/**
 * the nearest directory above sourcePath inside a pulled-extension root whose
 * manifest.yaml names that directory's path; undefined for local or mounted
 * sources; never reads above a pulled root
 */
export function pulledExtensionOf(
  repoDir: string,
  sourcePath: string,
): LocalManifestIdentity | undefined {
  const source = realCanonicalPath(sourcePath);
  for (
    const root of [
      swampPath(repoDir, "pulled-extensions"),
      swampPath(repoDir, "config", "pulled-extensions"),
    ]
  ) {
    const canonicalRoot = realCanonicalPath(root);
    let dir = dirname(source);
    let rel = relative(canonicalRoot, dir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    while (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const identity = readManifestIdentityAt(join(dir, "manifest.yaml"));
      if (identity !== null) {
        return canonicalizePath(identity.name) ===
            rel.split(SEPARATOR).join("/")
          ? identity
          : undefined;
      }
      dir = dirname(dir);
      rel = relative(canonicalRoot, dir);
    }
  }
  return undefined;
}

export function loadedDatastoreExtension(
  repoDir: string,
  type: string,
): LocalManifestIdentity | undefined {
  const sourcePath = datastoreTypeRegistry.get(type)?.sourcePath;
  if (sourcePath === undefined) return undefined;
  return pulledExtensionOf(repoDir, sourcePath);
}

/**
 * checks the pulled extension the type loaded from, then the version the
 * committed lockfile pins, which teammates install from; no pulled extension or
 * no lockfile entry means nothing to check
 */
export async function assertV3BucketExtensionVersions(
  repoDir: string,
  type: string,
  lockfilePath: string | undefined,
  resolveExtension: (
    repoDir: string,
    type: string,
  ) => LocalManifestIdentity | undefined = loadedDatastoreExtension,
): Promise<void> {
  const extension = resolveExtension(repoDir, type);
  if (extension === undefined) return;
  assertV3BucketExtensionVersion(
    extension.version,
    type,
    undefined,
    extension.name,
  );
  if (lockfilePath === undefined) return;
  const pinned = (await LockfileRepository.create(lockfilePath))
    .getLockedVersion(extension.name);
  assertV3BucketExtensionVersion(
    pinned ?? undefined,
    type,
    "the repo's lockfile pins its extension at",
    extension.name,
  );
}
