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

import { Command } from "@cliffy/command";
import { isAbsolute, join, resolve } from "@std/path";
import { createContext, resolveRepoDir } from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { migrateConfigToDatastore } from "../../domain/datastore/managed_config_migration.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

export const datastoreConfigMigrateCommand = new Command()
  .description(
    "Migrate configuration into the datastore.\n\n" +
      "Copies model definitions, workflow definitions, vault configs,\n" +
      "the extension lockfile, and pulled extensions into the datastore\n" +
      "config tier. Sets managedConfig: true in .swamp.yaml if not already\n" +
      "set. Idempotent — safe to re-run (sentinel prevents duplicate work).",
  )
  .option("--repo-dir <dir:string>", "Path to the swamp repository")
  // deno-lint-ignore no-explicit-any
  .action(async (options: any) => {
    const ctx = createContext(options);
    const repoDir = resolveRepoDir(options.repoDir);

    const {
      repoContext: _repoContext,
      datastoreResolver,
      datastoreConfig,
      syncService,
    } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: ctx.outputMode,
    });

    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const marker = await markerRepo.read(repoPath);

    if (!marker?.datastore) {
      throw new UserError(
        "No datastore configured. Set up a datastore with " +
          "'swamp datastore setup' before migrating config.",
      );
    }

    if (
      isCustomDatastoreConfig(datastoreConfig) && syncService &&
      !syncService.capabilities?.().configRefresh
    ) {
      throw new UserError(
        `The datastore extension "${datastoreConfig.type}" does not support ` +
          "managed config sync yet. Update the extension to the latest version " +
          "that supports the configRefresh capability before migrating.\n\n" +
          "Refusing to migrate — a partial migration would leave config in the " +
          "datastore that other instances cannot pull.",
      );
    }

    const configRoot = datastoreResolver.resolvePath("config");
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);
    const lockfileSourcePath = join(
      absoluteModelsDir,
      "upstream_extensions.json",
    );
    const pulledExtensionsSource = swampPath(repoDir, "pulled-extensions");

    const result = await migrateConfigToDatastore(
      repoDir,
      lockfileSourcePath,
      configRoot,
      pulledExtensionsSource,
    );

    if (result.alreadyMigrated) {
      if (ctx.outputMode === "json") {
        writeOutput(JSON.stringify({ alreadyMigrated: true }));
      } else {
        ctx.logger.info`Config migration already completed`;
      }
      return;
    }

    const managedConfigSet = !marker.datastore.managedConfig;
    if (managedConfigSet) {
      const updated: RepoMarkerData = {
        ...marker,
        datastore: { ...marker.datastore, managedConfig: true },
      };
      await markerRepo.write(repoPath, updated);
      if (ctx.outputMode !== "json") {
        ctx.logger.info`Set managedConfig: true in .swamp.yaml`;
      }
    }

    const copied = [
      result.copiedModels && "models",
      result.copiedWorkflows && "workflows",
      result.copiedVaults && "vaults",
      result.copiedLockfile && "lockfile",
      result.copiedPulledExtensions && "pulled-extensions",
    ].filter(Boolean);

    if (syncService && (copied.length > 0 || managedConfigSet)) {
      await syncService.markDirty();
      await syncService.pushChanged();
      if (ctx.outputMode !== "json") {
        ctx.logger.info`Pushed config to datastore`;
      }
    }

    if (ctx.outputMode === "json") {
      writeOutput(JSON.stringify({
        alreadyMigrated: false,
        copiedModels: result.copiedModels,
        copiedWorkflows: result.copiedWorkflows,
        copiedVaults: result.copiedVaults,
        copiedLockfile: result.copiedLockfile,
        copiedPulledExtensions: result.copiedPulledExtensions,
        managedConfigSet,
        configRoot,
      }));
    } else if (copied.length > 0) {
      ctx.logger
        .info`Migrated ${copied.join(", ")} into datastore config tier`;
    } else {
      ctx.logger.info`No config files found to migrate`;
    }
  });
