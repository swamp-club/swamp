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
import type {
  AutoResolveOutputPort,
  ExtensionInstallerPort,
} from "../domain/extensions/extension_auto_resolver.ts";
import {
  enumeratePulledExtensionDirs,
  type ExtensionRegistryInfo,
  installExtension,
} from "../libswamp/mod.ts";
import { UserModelLoader } from "../domain/models/user_model_loader.ts";
import { UserVaultLoader } from "../domain/vaults/user_vault_loader.ts";
import { UserDatastoreLoader } from "../domain/datastore/user_datastore_loader.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import {
  renderAutoResolveInstalled,
  renderAutoResolveInstalling,
  renderAutoResolveNetworkError,
  renderAutoResolveNotFound,
  renderAutoResolveSearching,
} from "../presentation/renderers/extension_auto_resolve.ts";

const logger = getLogger(["swamp", "extensions", "auto-resolver"]);

interface InstallerAdapterConfig {
  getExtension: (name: string) => Promise<ExtensionRegistryInfo | null>;
  downloadArchive: (name: string, version: string) => Promise<Uint8Array>;
  getChecksum: (name: string, version: string) => Promise<string | null>;
  /** Full path to the upstream_extensions.json lockfile. */
  lockfilePath: string;
  repoDir: string;
  denoRuntime: DenoRuntime;
  datastoreResolver?: DatastorePathResolver;
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
  } = config;

  return {
    async install(extensionName: string) {
      const result = await installExtension(
        { name: extensionName, version: null },
        {
          getExtension,
          downloadArchive,
          getChecksum,
          logger,
          lockfilePath,
          skillsDir: swampPath(repoDir, SWAMP_SUBDIRS.pulledSkills),
          repoDir,
          force: true,
          alreadyPulled: new Set(),
          depth: 0,
        },
      );
      if (!result) return null;
      return { version: result.version };
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
      const loader = new UserModelLoader(
        denoRuntime,
        repoDir,
        datastoreResolver,
      );
      const [primary, ...rest] = pulledDirs;
      const result = await loader.loadModels(primary, {
        skipAlreadyRegistered: true,
        additionalDirs: rest,
      });
      return result.loaded.length;
    },

    async hotLoadVaults() {
      const pulledDirs = await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "vaults",
      );
      if (pulledDirs.length === 0) return;
      const loader = new UserVaultLoader(
        denoRuntime,
        repoDir,
        datastoreResolver,
      );
      const [primary, ...rest] = pulledDirs;
      await loader.loadVaults(primary, {
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
      // Bootstrap: datastore loader must NOT receive the resolver —
      // it loads datastore extensions that configure the resolver.
      const loader = new UserDatastoreLoader(denoRuntime, repoDir);
      const [primary, ...rest] = pulledDirs;
      await loader.loadDatastores(primary, {
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
  };
}
