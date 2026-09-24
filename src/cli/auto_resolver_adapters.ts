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

import { getLogger } from "@logtape/logtape";
import {
  resolvePulledExtensionsRoot,
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { assertContainedPath } from "../infrastructure/persistence/safe_path.ts";
import { canonicalizePath } from "../infrastructure/persistence/canonicalize_path.ts";
import type { DenoRuntime } from "../domain/runtime/deno_runtime.ts";
import { join } from "@std/path";
import type {
  AutoResolveOutputPort,
  ExtensionInstallerPort,
  InstallationInspection,
} from "../domain/extensions/extension_auto_resolver.ts";
import {
  ConflictError,
  enumeratePulledExtensionDirs,
  type ExtensionRegistryInfo,
  installExtension,
  InstallExtensionService,
  LockfileRepository,
} from "../libswamp/mod.ts";
import { ExtensionLoader } from "../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../domain/extensions/datastore_kind_adapter.ts";
import { webhookKindAdapter } from "../domain/extensions/webhook_kind_adapter.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import type { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { modelRegistry } from "../domain/models/model.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import {
  renderAutoResolveAlreadyInstalled,
  renderAutoResolveCollectiveNotTrusted,
  renderAutoResolveInstalled,
  renderAutoResolveInstalledWithoutType,
  renderAutoResolveInstalling,
  renderAutoResolveLegacyInstallation,
  renderAutoResolveLocalSourceFailed,
  renderAutoResolveNetworkError,
  renderAutoResolveNoStableVersion,
  renderAutoResolveNotFound,
  renderAutoResolveSearching,
  renderAutoResolveTruncated,
} from "../presentation/renderers/extension_auto_resolve.ts";

const logger = getLogger(["swamp", "extensions", "auto-resolver"]);

// Lockfile-relative prefixes for regenerable bundle output. Sourced from
// SWAMP_SUBDIRS so a future bundle-dir addition only needs the key list
// extended below to stay in sync. Forward slashes match how
// installExtension writes lockfile paths (POSIX-normalized via
// `relative()` in src/libswamp/extensions/pull.ts).
const BUNDLE_ARTIFACT_PREFIXES: readonly string[] = [
  SWAMP_SUBDIRS.bundles,
  SWAMP_SUBDIRS.vaultBundles,
  SWAMP_SUBDIRS.datastoreBundles,
  SWAMP_SUBDIRS.reportBundles,
  SWAMP_SUBDIRS.webhookBundles,
].map((subdir) => `.swamp/${subdir}/`);

export function isBundleArtifactPath(relPath: string): boolean {
  return BUNDLE_ARTIFACT_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

const PULLED_SKILLS_PREFIX = `.swamp/${SWAMP_SUBDIRS.pulledSkills}/`;

/**
 * True for a skill dir under the pulled skills dir. Skills land in a
 * dir shared across extensions, so another extension shipping the same
 * skill name raises a ConflictError on it.
 */
export function isPulledSkillPath(relPath: string): boolean {
  return relPath.startsWith(PULLED_SKILLS_PREFIX);
}

interface InstallerAdapterConfig {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  downloadArchive: (
    name: string,
    version: string,
    channel?: string,
  ) => Promise<Uint8Array>;
  getChecksum: (
    name: string,
    version: string,
    channel?: string,
  ) => Promise<string | null>;
  /** Full path to the upstream_extensions.json lockfile. */
  lockfilePath: string;
  repoDir: string;
  denoRuntime: DenoRuntime;
  datastoreResolver?: DatastorePathResolver;
  pulledExtensionsRoot?: string;
  /**
   * W1b/(a-2) wiring: shared ExtensionRepository used by hotLoadModels
   * to attach user extensions whose base type was just registered, and
   * passed through to every loader's constructor so internal
   * catalog operations route through the repository. Optional
   * so existing callers that do not need the attach retry can omit it.
   */
  repository?: ExtensionRepository;
}

/**
 * Creates an ExtensionInstallerPort adapter that uses the CLI extension pull
 * infrastructure and user model/vault loaders.
 */
export function createAutoResolveInstallerAdapter(
  config: InstallerAdapterConfig,
): ExtensionInstallerPort {
  const {
    getExtension,
    downloadArchive,
    getChecksum,
    lockfilePath,
    repoDir,
    denoRuntime,
    datastoreResolver,
    repository,
  } = config;

  return {
    async inspectInstallation(
      extensionName: string,
    ): Promise<InstallationInspection> {
      // Inspection states: missing / intact / truncated / legacy.
      //
      // The lockfile is the source of truth for "which files should be
      // present". `installExtension` writes the lockfile entry in lockstep
      // with the file copy at the end of install, so the two stay
      // paired — if they drift, that's a bug in install, not here.
      //
      // - missing: no lockfile entry, or no lockfile-declared source files
      //   remain when the per-extension directory is absent. A clean install
      //   should proceed.
      // - truncated: lockfile + directory both present, but one or more
      //   listed source files are absent on disk (swamp-club#133). The
      //   tree is broken; surface a distinct error with `--force`
      //   recovery.
      // - intact: everything lined up. If the type still failed to
      //   register, either a source failed to load (user edits — issue
      //   #121's "never overwrite" guard applies) or the installed
      //   version does not provide the type (swamp-club#2476);
      //   `loadFailures` tells the resolver which.
      //
      // Bundle artifacts under .swamp/{bundles,vault-bundles,
      // datastore-bundles,report-bundles,webhook-bundles}/ are excluded
      // from the truncation check because they are regenerable build
      // output, not source. Clearing the bundle cache (a normal hygiene
      // operation) must not flip the inspection to truncated and steal
      // the user-WIP path from issue #121.
      const inspectLockfileRepo = await LockfileRepository.create(lockfilePath);
      const entry = inspectLockfileRepo.getEntry(extensionName);
      if (!entry) return { state: "missing" };
      // A lockfile entry exists; carry its pinned version so the installer's
      // progress output reports the version that will actually be installed
      // (the install path pins to it) rather than registry-latest.
      const pulledRoot = config.pulledExtensionsRoot ??
        resolvePulledExtensionsRoot(repoDir);
      const path = join(pulledRoot, extensionName);
      // Pre-anchor lockfile entries (grandfather path in
      // UpstreamExtensionEntry) may omit `files`. Treat an absent or
      // empty list as having no surviving legacy source.
      const files = entry.files ?? [];
      const existingFiles: string[] = [];
      const missing: string[] = [];
      for (const relPath of files) {
        // Lockfiles are repository-controlled input. Validate before statting
        // so inspection cannot probe paths outside the repository.
        assertContainedPath(relPath, repoDir);
        if (isBundleArtifactPath(relPath)) continue;
        try {
          await Deno.stat(join(repoDir, relPath));
          existingFiles.push(relPath);
        } catch {
          missing.push(relPath);
        }
      }
      try {
        const stat = await Deno.stat(path);
        if (!stat.isDirectory) {
          if (existingFiles.length > 0) {
            return { state: "legacy", paths: existingFiles };
          }
          return { state: "missing", lockedVersion: entry.version };
        }
      } catch {
        if (existingFiles.length > 0) {
          return { state: "legacy", paths: existingFiles };
        }
        return { state: "missing", lockedVersion: entry.version };
      }
      if (missing.length > 0) {
        return { state: "truncated", path, missing };
      }
      const loadFailures = repository
        ? hasFailedSourceUnder(repository, path)
        : undefined;
      return {
        state: "intact",
        path,
        installedVersion: entry.version,
        ...(loadFailures === undefined ? {} : { loadFailures }),
      };
    },

    async install(extensionName: string) {
      async function runInstall(force: boolean) {
        const lockfileRepo = await LockfileRepository.create(lockfilePath);
        const pinnedEntry = lockfileRepo.getEntry(extensionName);
        const ref = {
          name: extensionName,
          version: pinnedEntry?.version ?? null,
        };
        const installCtx = {
          getExtension,
          downloadArchive,
          getChecksum,
          logger,
          lockfileRepository: lockfileRepo,
          skillsDirs: [swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills)],
          repoDir,
          force,
          alreadyPulled: new Set<string>(),
          depth: 0,
          ...(pinnedEntry?.checksum
            ? { expectedChecksum: pinnedEntry.checksum }
            : {}),
        };
        return repository !== undefined
          ? await new InstallExtensionService({ denoRuntime, repository })
            .execute(ref, installCtx)
          : await installExtension(ref, installCtx);
      }

      // force: false so installExtension raises ConflictError rather than
      // silently overwriting any existing files. The service's
      // inspectInstallation check normally prevents reaching this point
      // when the extension is already on disk (intact or truncated); the
      // ConflictError catch below is defence-in-depth for races between
      // inspect and install that the per-type re-entrancy guard in the
      // resolver cannot cover (e.g. two types resolving the same
      // extension concurrently).
      try {
        const result = await runInstall(false);
        if (!result) return null;
        return { version: result.version };
      } catch (error) {
        if (error instanceof ConflictError) {
          // Stale bundle output is regenerable, and a shared skill dir is
          // merged into with a warning (swamp-club#2494). Any other
          // conflict means real files are in the way.
          const conflicts = error.conflicts.map((p) => p.replaceAll("\\", "/"));
          const bundleConflicts = conflicts.filter(isBundleArtifactPath);
          const skillConflicts = conflicts.filter(isPulledSkillPath);
          const allRetryable = conflicts.length > 0 &&
            bundleConflicts.length + skillConflicts.length === conflicts.length;
          if (allRetryable) {
            if (bundleConflicts.length > 0) {
              logger
                .warn`Auto-install of ${extensionName}: overwriting stale bundle cache (${bundleConflicts.length} file(s))`;
            }
            if (skillConflicts.length > 0) {
              logger
                .warn`Auto-install of ${extensionName}: writing into existing skill dir(s) ${
                skillConflicts.join(", ")
              }`;
            }
            const retryResult = await runInstall(true);
            if (!retryResult) return null;
            return { version: retryResult.version };
          }
          logger
            .warn`Auto-install of ${extensionName} failed: files already exist on disk and the type was not registered. To resolve: swamp extension pull ${extensionName} --force`;
          return null;
        }
        throw error;
      }
    },

    // Hot-load walks every pulled extension's per-type subtree (via
    // enumeratePulledExtensionDirs). Under issue 120's per-extension
    // layout, each extension owns .swamp/pulled-extensions/<ext-name>/,
    // so there is no single shared directory to pass to the loader.
    // skipAlreadyRegistered lets the newly-installed extension's types
    // register while already-loaded types stay put.
    async hotLoadModels() {
      const pulledDirs = await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "models",
      );
      if (pulledDirs.length === 0) return 0;
      const loader = new ExtensionLoader(
        denoRuntime,
        modelKindAdapter,
        repoDir,
        datastoreResolver,
        repository,
      );
      const [primary, ...rest] = pulledDirs;
      const result = await loader.load(primary, {
        skipAlreadyRegistered: true,
        additionalDirs: rest,
      });

      // Attach any user extensions in extensions/models/ whose base type
      // was just registered. loadModels Pass 1 fully-registers new bases
      // via modelRegistry.register (not lazy), so ensureTypeLoaded would
      // short-circuit and loadSingleType's extension-attach loop would
      // never run. Walk the catalog's extension rows and attach any whose
      // base is now fully loaded. Idempotent (issue 123).
      if (repository && result.loaded.length > 0) {
        const pendingBases = new Set<string>();
        for (
          const row of repository.findByKind("extension")
        ) {
          // Validation-failed rows (swamp-club#209) have empty
          // extends_type so they fall out of this set naturally — the
          // explicit emptiness check below already filters them.
          if (row.extends_type) pendingBases.add(row.extends_type);
        }
        for (const type of pendingBases) {
          if (!modelRegistry.get(type)) continue;
          await loader.attachPendingExtensionsForType(type);
        }
      }

      return result.loaded.length;
    },

    async hotLoadVaults() {
      const pulledDirs = await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "vaults",
      );
      if (pulledDirs.length === 0) return;
      const loader = new ExtensionLoader(
        denoRuntime,
        vaultKindAdapter,
        repoDir,
        datastoreResolver,
        repository,
      );
      const [primary, ...rest] = pulledDirs;
      await loader.load(primary, {
        skipAlreadyRegistered: true,
        additionalDirs: rest,
      });
    },

    async hotLoadDatastores() {
      const pulledDirs = await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "datastores",
      );
      if (pulledDirs.length === 0) return;
      const loader = new ExtensionLoader(
        denoRuntime,
        datastoreKindAdapter,
        repoDir,
        undefined,
        repository,
      );
      const [primary, ...rest] = pulledDirs;
      await loader.load(primary, {
        skipAlreadyRegistered: true,
        additionalDirs: rest,
      });
    },

    async hotLoadWebhooks() {
      const pulledDirs = await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "webhooks",
      );
      if (pulledDirs.length === 0) return;
      const loader = new ExtensionLoader(
        denoRuntime,
        webhookKindAdapter,
        repoDir,
        datastoreResolver,
        repository,
      );
      const [primary, ...rest] = pulledDirs;
      await loader.load(primary, {
        skipAlreadyRegistered: true,
        additionalDirs: rest,
      });
    },

    failedLocalSourceMatchesType(typeNormalized: string): boolean {
      if (!repository) return false;
      const paths = repository.getCatalogStore().getFailedLocalSourcePaths();
      for (const sourcePath of paths) {
        try {
          const source = Deno.readTextFileSync(sourcePath);
          if (source.includes(typeNormalized)) return true;
        } catch {
          // Source unreadable — skip this file
        }
      }
      return false;
    },
  };
}

/** Catalog row states that mean a source failed to load (as in doctor). */
const FAILED_SOURCE_STATES: ReadonlySet<string> = new Set([
  "BundleBuildFailed",
  "ValidationFailed",
  "EntryPointUnreadable",
]);

/**
 * Whether any catalog row for a source under `extensionDir` is in a failed
 * state. Matches by path rather than extension_name: failed pulled sources
 * can be recorded under a placeholder identity (swamp-club#2505). The
 * trailing "/" keeps `@x/foo` from matching `@x/foo-bar`, and the
 * `startsWith` re-check discards rows that SQL LIKE matched only because
 * `_` or `%` in the name acted as a wildcard.
 */
function hasFailedSourceUnder(
  repository: ExtensionRepository,
  extensionDir: string,
): boolean {
  const prefix = `${canonicalizePath(extensionDir)}/`;
  return repository.getCatalogStore().findBySourcePathPrefix(prefix).some(
    (row) =>
      row.source_path.startsWith(prefix) &&
      row.state !== undefined && FAILED_SOURCE_STATES.has(row.state),
  );
}

/**
 * Creates an AutoResolveOutputPort adapter that renders auto-resolution
 * events to the terminal in log or JSON mode.
 */
export function createAutoResolveOutputAdapter(
  mode: OutputMode,
): AutoResolveOutputPort {
  return {
    searching(type: string) {
      renderAutoResolveSearching(type, mode);
    },
    installing(
      extension: string,
      version: string,
      description: string | undefined,
    ) {
      renderAutoResolveInstalling(extension, version, description, mode);
    },
    installed(extension: string, version: string, modelsRegistered: number) {
      renderAutoResolveInstalled(extension, version, modelsRegistered, mode);
    },
    notFound(type: string) {
      renderAutoResolveNotFound(type, mode);
    },
    networkError(type: string, error: string) {
      renderAutoResolveNetworkError(type, error, mode);
    },
    alreadyInstalledButFailed(extension: string, path: string) {
      renderAutoResolveAlreadyInstalled(extension, path, mode);
    },
    installedWithoutType(
      extension: string,
      type: string,
      installedVersion: string | undefined,
      newerVersion: string | undefined,
    ) {
      renderAutoResolveInstalledWithoutType(
        extension,
        type,
        installedVersion,
        newerVersion,
        mode,
      );
    },
    alreadyInstalledTruncated(
      extension: string,
      path: string,
      missing: string[],
    ) {
      renderAutoResolveTruncated(extension, path, missing, mode);
    },
    legacyInstallation(extension: string, paths: string[]) {
      renderAutoResolveLegacyInstallation(extension, paths, mode);
    },
    collectiveNotTrusted(collective: string, type: string) {
      renderAutoResolveCollectiveNotTrusted(collective, type, mode);
    },
    localSourceFailed(type: string) {
      renderAutoResolveLocalSourceFailed(type, mode);
    },
    noStableVersion(extension: string) {
      renderAutoResolveNoStableVersion(extension, mode);
    },
  };
}
