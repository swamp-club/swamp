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

import { getLogger } from "@logtape/logtape";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
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
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import type { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { modelRegistry } from "../domain/models/model.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import {
  renderAutoResolveAlreadyInstalled,
  renderAutoResolveInstalled,
  renderAutoResolveInstalling,
  renderAutoResolveNetworkError,
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
  SWAMP_SUBDIRS.driverBundles,
  SWAMP_SUBDIRS.datastoreBundles,
  SWAMP_SUBDIRS.reportBundles,
].map((subdir) => `.swamp/${subdir}/`);

function isBundleArtifactPath(relPath: string): boolean {
  return BUNDLE_ARTIFACT_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

interface InstallerAdapterConfig {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  downloadArchive: (name: string, version: string) => Promise<Uint8Array>;
  getChecksum: (name: string, version: string) => Promise<string | null>;
  /** Full path to the upstream_extensions.json lockfile. */
  lockfilePath: string;
  repoDir: string;
  denoRuntime: DenoRuntime;
  datastoreResolver?: DatastorePathResolver;
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
      // Tri-state inspection: missing / intact / truncated.
      //
      // The lockfile is the source of truth for "which files should be
      // present". `installExtension` writes the lockfile entry in lockstep
      // with the file copy at the end of install, so the two stay
      // paired — if they drift, that's a bug in install, not here.
      //
      // - missing: no lockfile entry, or the per-extension directory is
      //   absent. A clean install should proceed.
      // - truncated: lockfile + directory both present, but one or more
      //   listed source files are absent on disk (swamp-club#133). The
      //   tree is broken; surface a distinct error with `--force`
      //   recovery.
      // - intact: everything lined up. If the type still failed to
      //   register, the cause is local (user edits) — issue #121's
      //   "never overwrite" guard applies.
      //
      // Bundle artifacts under .swamp/{bundles,vault-bundles,
      // driver-bundles,datastore-bundles,report-bundles}/ are excluded
      // from the truncation check because they are regenerable build
      // output, not source. Clearing the bundle cache (a normal hygiene
      // operation) must not flip the inspection to truncated and steal
      // the user-WIP path from issue #121.
      const inspectLockfileRepo = await LockfileRepository.create(lockfilePath);
      const entry = inspectLockfileRepo.getEntry(extensionName);
      if (!entry) return { state: "missing" };
      const path = swampPath(repoDir, "pulled-extensions", extensionName);
      try {
        const stat = await Deno.stat(path);
        if (!stat.isDirectory) return { state: "missing" };
      } catch {
        return { state: "missing" };
      }
      // Pre-anchor lockfile entries (grandfather path in
      // UpstreamExtensionEntry) may omit `files`. Treat an absent or
      // empty list as vacuously intact — there's nothing the lockfile
      // claims should be on disk, so we can't detect truncation.
      const files = entry.files ?? [];
      const missing: string[] = [];
      for (const relPath of files) {
        if (isBundleArtifactPath(relPath)) continue;
        try {
          await Deno.stat(join(repoDir, relPath));
        } catch {
          missing.push(relPath);
        }
      }
      if (missing.length > 0) {
        return { state: "truncated", path, missing };
      }
      return { state: "intact", path };
    },

    async install(extensionName: string) {
      // force: false so installExtension raises ConflictError rather than
      // silently overwriting any existing files. The service's
      // inspectInstallation check normally prevents reaching this point
      // when the extension is already on disk (intact or truncated); the
      // ConflictError catch below is defence-in-depth for races between
      // inspect and install that the per-type re-entrancy guard in the
      // resolver cannot cover (e.g. two types resolving the same
      // extension concurrently).
      try {
        // Construct a fresh LockfileRepository per install to capture a
        // current snapshot — the InstallContext is single-use per its
        // JSDoc.
        const lockfileRepository = await LockfileRepository.create(
          lockfilePath,
        );
        const installCtx = {
          getExtension,
          downloadArchive,
          getChecksum,
          logger,
          lockfileRepository,
          skillsDir: swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills),
          repoDir,
          force: false,
          alreadyPulled: new Set<string>(),
          depth: 0,
        };
        // W2 (commit 3): route through InstallExtensionService when an
        // ExtensionRepository is available so phase 8 fires (catalog
        // populated synchronously, I-Repo-1 fires on `(kind, type)`
        // collision). When the repository isn't wired (e.g. headless
        // bootstrap paths), fall back to the pre-W2 free function — the
        // catalog gets populated lazily on next loader pass.
        const result = repository !== undefined
          ? await new InstallExtensionService({ denoRuntime, repository })
            .execute({ name: extensionName, version: null }, installCtx)
          : await installExtension(
            { name: extensionName, version: null },
            installCtx,
          );
        if (!result) return null;
        return { version: result.version };
      } catch (error) {
        if (error instanceof ConflictError) {
          logger
            .debug`Auto-install of ${extensionName} hit conflicts: ${error.conflicts}`;
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
  };
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
    alreadyInstalledTruncated(
      extension: string,
      path: string,
      missing: string[],
    ) {
      renderAutoResolveTruncated(extension, path, missing, mode);
    },
  };
}
