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

import { join } from "@std/path";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { cleanupEmptyParentDirs } from "../../infrastructure/persistence/directory_cleanup.ts";
import { installedDigestMatches } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";
import { nestedEntryRelDirs } from "../../domain/extensions/install_journal.ts";
import {
  readManifestDependenciesAt,
  readManifestIdentityAt,
} from "../../infrastructure/persistence/local_manifest_reader.ts";
import { assertContainedPath } from "../../infrastructure/persistence/safe_path.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  isManagedLockfile,
  ManagedLockfileUnpublishedError,
  refreshManagedLockfile,
} from "./managed_lockfile_transaction.ts";
import {
  type ExtensionRef,
  type InstallContext,
  installExtension,
  type InstallResult,
  isVersionConstraint,
  parseExtensionRef,
} from "./pull.ts";
import { classifyExtensionFile, isSkillDirEntryMulti } from "./layout.ts";

/**
 * test seam: production always uses installExtension from pull.ts; returns
 * undefined when the extension was already pulled earlier in the same call
 * chain, and result.pruned carries the paths removed during orphan cleanup
 */
export type InstallExtensionFn = (
  ref: ExtensionRef,
  ctx: InstallContext,
) => Promise<InstallResult | undefined>;

export interface ExtensionInstallEntry {
  name: string;
  version: string;
  status: "installed" | "migrated" | "up_to_date" | "failed";
  error?: string;
}

export interface ExtensionInstallData {
  entries: ExtensionInstallEntry[];
  installed: number;
  migrated: number;
  upToDate: number;
  failed: number;
}

export type ExtensionInstallEvent =
  | { kind: "resolving" }
  | { kind: "installing"; name: string; version: string }
  | { kind: "migrating"; name: string; version: string }
  | {
    kind: "orphans-pruned";
    name: string;
    version: string;
    paths: string[];
  }
  | { kind: "completed"; data: ExtensionInstallData }
  | { kind: "error"; error: SwampError };

export interface ExtensionInstallDeps {
  lockfilePath: string;
  repoDir: string;
  /**
   * repo-relative because lockfile files[] paths are, and isSkillDirEntry compares
   * them directly (InstallContext.skillsDirs is absolute); without it the
   * tool=none skills path looks like a gen-2 path and the sweep would remove it
   */
  skillsDirsRelative?: string[];
  /**
   * async because each context captures a snapshot of the lockfile at
   * construction, which is an async file read
   */
  createInstallContext: (
    name: string,
    version: string,
  ) => Promise<InstallContext>;
  installExtensionFn?: InstallExtensionFn;
  pulledExtensionsRoot?: string;
  /**
   * a repo upgrade's install pass sets it false, so an upgrade with nothing to
   * restore never contacts the datastore; each entry it does install is still
   * made against the datastore's lockfile
   */
  refreshFromDatastore?: boolean;
}

/**
 * for legacy-layout entries the original files[] list is captured before
 * install, since installExtension rewrites the lockfile to current-layout
 * paths, and the original legacy paths are swept afterward
 */
export async function* extensionInstall(
  _ctx: LibSwampContext,
  deps: ExtensionInstallDeps,
): AsyncIterable<ExtensionInstallEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.install",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const lockfileRepository = await LockfileRepository.create(
        deps.lockfilePath,
      );
      // restore what the datastore's lockfile pins, not a stale cache
      if (deps.refreshFromDatastore !== false) {
        await refreshManagedLockfile(lockfileRepository);
      }
      const upstream = lockfileRepository.getAllEntries();
      const entries: ExtensionInstallEntry[] = [];
      let unpublished: ManagedLockfileUnpublishedError | undefined;
      let installed = 0;
      let migrated = 0;
      let upToDate = 0;
      let failed = 0;

      for (const [name, entry] of Object.entries(upstream)) {
        const version = entry.version;
        const originalFiles = entry.files ?? [];

        let needs = await needsInstallOrMigration(
          originalFiles,
          deps.repoDir,
          deps.skillsDirsRelative,
        );

        // presence alone says nothing about which version is sitting on disk,
        // so reconcile against the lockfile entry
        if (needs === "up_to_date") {
          const effectivePulledRoot = deps.pulledExtensionsRoot ??
            resolvePulledExtensionsRoot(deps.repoDir);
          // The lockfile is repo-controlled input: reject an entry name
          // that escapes the pulled root before any filesystem access.
          assertContainedPath(name, effectivePulledRoot);
          const extRoot = join(effectivePulledRoot, name);

          // the pin is the authority: a different version already on disk is
          // re-pulled; a constraint pin or a missing or malformed manifest
          // yields no identity and leaves the decision to the content check
          if (!isVersionConstraint(version)) {
            const identity = readManifestIdentityAt(
              join(extRoot, "manifest.yaml"),
            );
            if (identity && identity.version !== version) {
              needs = "install";
            }
          }

          // files at the current layout can still differ from filesChecksum
          // when the lockfile was updated via git but the files were not
          // re-fetched
          if (needs === "up_to_date" && entry.filesChecksum) {
            try {
              const matches = await installedDigestMatches(
                extRoot,
                entry.filesChecksum,
                nestedEntryRelDirs(name, Object.keys(upstream)),
              );
              if (matches !== true) {
                needs = "install";
              }
            } catch {
              // Degrade gracefully on I/O errors — don't block install.
            }
          }

          // a dependency install that failed after the parent was written, or a
          // hand-edited lockfile, leaves the dependency unrecorded; re-pulling
          // the parent runs its dependency loop
          if (
            needs === "up_to_date" &&
            await hasUnrecordedDependency(
              join(extRoot, "manifest.yaml"),
              lockfileRepository,
              deps.lockfilePath,
            )
          ) {
            needs = "install";
          }
        }

        if (needs === "up_to_date") {
          entries.push({ name, version, status: "up_to_date" });
          upToDate++;
          continue;
        }

        yield needs === "migrate"
          ? { kind: "migrating", name, version }
          : { kind: "installing", name, version };

        try {
          const installCtx = await deps.createInstallContext(name, version);
          // the lockfile's stored checksum is an integrity anchor:
          // installExtension fails loudly if the downloaded archive differs;
          // entries without a stored checksum skip verification
          if (entry.checksum) {
            installCtx.expectedChecksum = entry.checksum;
          }
          // Restore on the entry's release channel so the registry is
          // queried for it and the rewritten entry keeps it.
          if (entry.channel) {
            installCtx.channel = entry.channel;
          }
          const ref = parseExtensionRef(`${name}@${version}`);
          const install = deps.installExtensionFn ?? installExtension;
          let result: InstallResult | undefined;
          try {
            result = await install(ref, installCtx);
          } catch (error) {
            // Installed and recorded; only the datastore publish failed.
            // Count it as done and raise the error after the report.
            if (!(error instanceof ManagedLockfileUnpublishedError)) {
              throw error;
            }
            unpublished ??= error;
          }

          if (needs === "migrate") {
            await sweepLegacyPaths(
              originalFiles,
              deps.repoDir,
              deps.skillsDirsRelative,
            );
            entries.push({ name, version, status: "migrated" });
            migrated++;
          } else {
            entries.push({ name, version, status: "installed" });
            installed++;
          }

          // result.pruned is the source of truth for orphan removals; there is
          // nothing to emit when the test seam returns undefined or the install
          // was a no-op
          if (result && result.pruned.length > 0) {
            yield {
              kind: "orphans-pruned",
              name,
              version,
              paths: result.pruned,
            };
          }
        } catch (error) {
          entries.push({
            name,
            version,
            status: "failed",
            error: String(error),
          });
          failed++;
        }
      }

      // a lockfile written on another OS reads the same but its paths differ
      // from what this checkout writes: rewrite it once so the committed file
      // stops changing between checkouts; the managed lockfile is not committed
      if (!isManagedLockfile(deps.lockfilePath)) {
        await lockfileRepository.normalize();
      }

      yield {
        kind: "completed",
        data: { entries, installed, migrated, upToDate, failed },
      };
      if (unpublished) throw unpublished;
    })(),
  );
}

/**
 * matched by name, so a constrained ref is satisfied by any recorded version; a
 * snapshot miss is re-read from the lockfile on disk; an unparseable dependency
 * counts as unrecorded
 */
async function hasUnrecordedDependency(
  manifestPath: string,
  snapshot: LockfileRepository,
  lockfilePath: string,
): Promise<boolean> {
  let current: LockfileRepository | undefined;
  for (const dep of readManifestDependenciesAt(manifestPath)) {
    let depName: string;
    try {
      depName = parseExtensionRef(dep).name;
    } catch {
      return true;
    }
    if (snapshot.getEntry(depName) !== null) continue;
    current ??= await LockfileRepository.create(lockfilePath);
    if (current.getEntry(depName) === null) return true;
  }
  return false;
}

/**
 * missing beats legacy: a missing file cannot be migrated without a re-pull.
 * Skill dir entries are always current-layout, but their presence is still
 * checked so a deleted skill dir triggers install and self-heals
 */
export async function needsInstallOrMigration(
  files: string[],
  repoDir: string,
  skillsDirsRelative?: string[],
): Promise<"install" | "migrate" | "up_to_date"> {
  let hasLegacy = false;
  for (const file of files) {
    assertContainedPath(file, repoDir);
    const absolutePath = join(repoDir, file);
    try {
      await Deno.stat(absolutePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return "install";
      }
      throw error;
    }
    if (isSkillDirEntryMulti(file, skillsDirsRelative)) {
      continue;
    }
    const generation = classifyExtensionFile(file);
    if (generation !== "current") {
      hasLegacy = true;
    }
  }
  return hasLegacy ? "migrate" : "up_to_date";
}

/**
 * NotFound is tolerated; recursive removal handles directory entries such as
 * legacy skill dirs; skill dir entries are excluded, else a tool=none skills
 * path looks like a gen-2 path and is removed
 */
export async function sweepLegacyPaths(
  originalFiles: string[],
  repoDir: string,
  skillsDirsRelative?: string[],
): Promise<void> {
  for (const file of originalFiles) {
    assertContainedPath(file, repoDir);
    if (isSkillDirEntryMulti(file, skillsDirsRelative)) {
      continue;
    }
    if (classifyExtensionFile(file) === "current") {
      continue;
    }
    const absolutePath = join(repoDir, file);
    try {
      await Deno.remove(absolutePath, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    await cleanupEmptyParentDirs(absolutePath, repoDir);
  }
}
