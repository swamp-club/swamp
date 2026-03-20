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
import { isAbsolute, resolve } from "@std/path";
import type { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import type { DenoRuntime } from "../domain/runtime/deno_runtime.ts";
import type {
  AutoResolveOutputPort,
  ExtensionInstallerPort,
} from "../domain/extensions/extension_auto_resolver.ts";
import { installExtension } from "./commands/extension_pull.ts";
import { UserModelLoader } from "../domain/models/user_model_loader.ts";
import { UserVaultLoader } from "../domain/vaults/user_vault_loader.ts";
import type { OutputMode } from "../presentation/output/output.ts";
import {
  renderAutoResolveInstalled,
  renderAutoResolveInstalling,
  renderAutoResolveNetworkError,
  renderAutoResolveNotFound,
  renderAutoResolveSearching,
} from "../presentation/output/extension_auto_resolve_output.ts";

const logger = getLogger(["swamp", "extensions", "auto-resolver"]);

interface InstallerAdapterConfig {
  extensionClient: ExtensionApiClient;
  modelsDir: string;
  workflowsDir: string;
  vaultsDir: string;
  driversDir: string;
  datastoresDir: string;
  reportsDir: string;
  repoDir: string;
  denoRuntime: DenoRuntime;
}

/**
 * Creates an ExtensionInstallerPort adapter that uses the CLI extension pull
 * infrastructure and user model/vault loaders.
 */
export function createAutoResolveInstallerAdapter(
  config: InstallerAdapterConfig,
): ExtensionInstallerPort {
  const {
    extensionClient,
    modelsDir,
    workflowsDir,
    vaultsDir,
    driversDir,
    datastoresDir,
    reportsDir,
    repoDir,
    denoRuntime,
  } = config;

  return {
    async install(extensionName: string) {
      const result = await installExtension(
        { name: extensionName, version: null },
        {
          extensionClient,
          logger,
          modelsDir,
          workflowsDir,
          vaultsDir,
          driversDir,
          datastoresDir,
          reportsDir,
          repoDir,
          force: true,
          alreadyPulled: new Set(),
          depth: 0,
        },
      );
      if (!result) return null;
      return { version: result.version };
    },

    async hotLoadModels() {
      const absoluteModelsDir = isAbsolute(modelsDir)
        ? modelsDir
        : resolve(repoDir, modelsDir);
      const loader = new UserModelLoader(denoRuntime, repoDir);
      const result = await loader.loadModels(absoluteModelsDir, {
        skipAlreadyRegistered: true,
      });
      return result.loaded.length;
    },

    async hotLoadVaults() {
      const absoluteVaultsDir = isAbsolute(vaultsDir)
        ? vaultsDir
        : resolve(repoDir, vaultsDir);
      const loader = new UserVaultLoader(denoRuntime, repoDir);
      await loader.loadVaults(absoluteVaultsDir, {
        skipAlreadyRegistered: true,
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
