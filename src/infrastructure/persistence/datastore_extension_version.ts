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
 * Which pulled extension, at which version, a loaded datastore type came
 * from (swamp-club#3567), so a v3 bucket datastore can refuse an extension
 * older than the release it needs.
 *
 * @module
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
 * Throws when `version` is a published release older than
 * {@link V3_BUCKET_MIN_EXTENSION_VERSION}. A version that is unknown or not
 * a published calendar version (a local or mounted source) passes: the
 * capability check still runs for it.
 *
 * @param where - what the version is, for the message, e.g. "its
 *   extension is" or "the repo's lockfile pins its extension at"
 * @param extensionName - the extension the refusal tells the user to
 *   update; the datastore type when unknown
 * @throws V3BucketExtensionTooOldError
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
 * The pulled extension that ships `sourcePath`: the nearest directory above
 * it, inside one of the checkout's pulled-extension roots, whose
 * `manifest.yaml` names that directory's own path under the root. Returns
 * undefined for a source outside the pulled roots (a local or mounted
 * extension) or one with no such manifest. Never reads above a pulled root.
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

/**
 * The pulled extension the loaded datastore `type` came from, or undefined
 * when the type is not loaded, is built in, or is not a pulled extension.
 */
export function loadedDatastoreExtension(
  repoDir: string,
  type: string,
): LocalManifestIdentity | undefined {
  const sourcePath = datastoreTypeRegistry.get(type)?.sourcePath;
  if (sourcePath === undefined) return undefined;
  return pulledExtensionOf(repoDir, sourcePath);
}

/**
 * Refuses a v3 bucket datastore setup whose datastore extension is older
 * than {@link V3_BUCKET_MIN_EXTENSION_VERSION} (swamp-club#3567): the
 * pulled extension the type was loaded from, then the version the repo's
 * committed lockfile pins it at, which teammates install from. A type not
 * loaded from a pulled extension, and a lockfile with no entry for it,
 * have nothing to check.
 *
 * @param lockfilePath - the committed lockfile, or undefined when the repo
 *   pins extensions in its datastore's config tier (managedConfig)
 * @throws V3BucketExtensionTooOldError
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
