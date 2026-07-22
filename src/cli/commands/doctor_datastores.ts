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
import {
  consumeStream,
  createLibSwampContext,
  doctorDatastores,
  type DoctorDatastoresData,
  type DoctorDatastoresDeps,
  repairDatastoreContamination,
  type RepairDatastoresDeps,
} from "../../libswamp/mod.ts";
import {
  createDoctorDatastoresRenderer,
  createRepairDatastoresRenderer,
} from "../../presentation/renderers/doctor_datastores.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DoctorDatastoresResponse } from "../../serve/protocol.ts";
import {
  type CustomDatastoreConfig,
  DEFAULT_DATASTORE_SUBDIRS,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { UserError } from "../../domain/errors.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { resolveDatastoreConfig } from "../resolve_datastore.ts";
import { RUNS_INDEX_FILENAME } from "../../infrastructure/persistence/workflow_run_index.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { join } from "@std/path";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function resolveProvider(
  config: CustomDatastoreConfig,
): Promise<DatastoreProvider> {
  await datastoreTypeRegistry.ensureTypeLoaded(config.type);
  const typeInfo = datastoreTypeRegistry.get(config.type);
  if (!typeInfo?.createProvider) {
    throw new Error(
      `No provider available for datastore type "${config.type}"`,
    );
  }
  return typeInfo.createProvider(config.config);
}

async function createDoctorDatastoresDeps(
  repoDir: string,
): Promise<DoctorDatastoresDeps> {
  await datastoreTypeRegistry.ensureLoaded();
  return {
    getDatastoreConfig: async () => {
      const markerRepo = new RepoMarkerRepository();
      const marker = await markerRepo.read(RepoPath.create(repoDir));
      return await resolveDatastoreConfig(marker, undefined, repoDir);
    },
    checkHealth: async (config) => {
      if (isCustomDatastoreConfig(config)) {
        await datastoreTypeRegistry.ensureTypeLoaded(config.type);
        const typeInfo = datastoreTypeRegistry.get(config.type);
        if (typeInfo?.createProvider) {
          const provider = typeInfo.createProvider(config.config);
          const verifier = provider.createVerifier();
          return await verifier.verify();
        }
        return {
          healthy: false,
          message: "No provider available for datastore type",
          latencyMs: 0,
        };
      } else {
        const verifier = new FilesystemDatastoreVerifier(config.path);
        return await verifier.verify();
      }
    },
    getVaultConfigs: async () => {
      const vaultRepo = new YamlVaultConfigRepository(repoDir);
      try {
        const vaultConfigs = await vaultRepo.findAll();
        return vaultConfigs.map((vc) => ({ name: vc.name, type: vc.type }));
      } catch {
        return [];
      }
    },
    checkUnmigratedData: async (config) => {
      if (!config.namespace) {
        return { unmigrated: false, directories: [] };
      }
      const basePath = isCustomDatastoreConfig(config) && config.cachePath
        ? config.cachePath
        : isCustomDatastoreConfig(config)
        ? config.datastorePath
        : config.path;
      const found: string[] = [];
      for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
        try {
          const stat = await Deno.stat(join(basePath, subdir));
          if (stat.isDirectory) found.push(subdir);
        } catch {
          // Directory doesn't exist — expected when migrated
        }
      }
      return { unmigrated: found.length > 0, directories: found };
    },
    checkNamespaceContamination: async (config) => {
      if (
        !config.namespace || !isCustomDatastoreConfig(config)
      ) {
        return null;
      }
      const provider = await resolveProvider(config);
      const cachePath = provider.resolveCachePath?.(repoDir) ??
        config.cachePath ?? config.datastorePath;
      const syncService = provider.createSyncService?.(repoDir, cachePath);
      if (!syncService?.repairNamespaceContamination) return null;

      return await syncService.repairNamespaceContamination({
        namespace: config.namespace,
        dryRun: true,
      });
    },
  };
}

async function createRepairDeps(
  repoDir: string,
): Promise<RepairDatastoresDeps> {
  await datastoreTypeRegistry.ensureLoaded();

  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(RepoPath.create(repoDir));
  const config = await resolveDatastoreConfig(marker, undefined, repoDir);

  if (!isCustomDatastoreConfig(config) || !config.namespace) {
    throw new UserError(
      "Repair is only available for custom datastores with a namespace configured.",
    );
  }

  const provider = await resolveProvider(config);
  const cachePath = provider.resolveCachePath?.(repoDir) ??
    config.cachePath ?? config.datastorePath;
  const syncService = provider.createSyncService?.(repoDir, cachePath);

  if (!syncService?.repairNamespaceContamination) {
    throw new UserError(
      `Datastore type "${config.type}" does not support namespace contamination repair.`,
    );
  }

  const namespace = config.namespace;

  return {
    getDatastoreConfig: () => Promise.resolve(config),
    detectContamination: () =>
      syncService.repairNamespaceContamination!({
        namespace,
        dryRun: true,
      }),
    deleteContamination: () =>
      syncService.repairNamespaceContamination!({
        namespace,
        dryRun: false,
      }),
    wipeLocalCache: async () => {
      for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
        const dir = join(cachePath, namespace, subdir);
        try {
          await Deno.remove(dir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    },
    pullScoped: async () => {
      const count = await syncService.pullChanged({ namespace });
      return count ?? 0;
    },
    invalidateWorkflowRunIndexes: async () => {
      let invalidated = 0;
      const dirs = [
        swampPath(repoDir, "workflow-runs"),
        join(cachePath, namespace, "workflow-runs"),
      ];
      for (const workflowRunsDir of dirs) {
        try {
          for await (const entry of Deno.readDir(workflowRunsDir)) {
            if (entry.isDirectory) {
              const indexPath = join(
                workflowRunsDir,
                entry.name,
                RUNS_INDEX_FILENAME,
              );
              try {
                await Deno.remove(indexPath);
                invalidated++;
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
              }
            }
          }
          const rootIndex = join(workflowRunsDir, RUNS_INDEX_FILENAME);
          try {
            await Deno.remove(rootIndex);
            invalidated++;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      return invalidated;
    },
    invalidateCatalog: async () => {
      const dbPath = catalogDbPath(repoDir);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        try {
          await Deno.remove(dbPath + suffix);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    },
  };
}

export const doctorDatastoresCommand = withRemoteOptions(
  new Command()
    .description(
      "Check that the configured datastore is healthy and flag any " +
        "vault compatibility issues.",
    )
    .example("Check this repo's datastore", "swamp doctor datastores")
    .example("Machine-readable output for CI", "swamp doctor datastores --json")
    .example(
      "Preview namespace contamination cleanup",
      "swamp doctor datastores --repair",
    )
    .example(
      "Execute namespace contamination cleanup",
      "swamp doctor datastores --repair -y",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--repair",
      "Preview foreign namespace contamination cleanup (add -y to execute).",
    )
    .option(
      "-y, --yes",
      "Execute the repair (without this, --repair shows a preview).",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "doctor",
    "datastores",
  ]);
  cliCtx.logger.debug("Executing doctor datastores command");

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<DoctorDatastoresResponse>(
      { server, token },
      {
        type: "doctor.datastores",
        payload: {},
      },
    );
    const renderer = createDoctorDatastoresRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as DoctorDatastoresData,
        };
      })(),
      renderer.handlers(),
    );
    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
    return;
  }

  if (options.yes && !options.repair) {
    throw new UserError("The --yes flag requires --repair.");
  }

  const repoDir = resolveRepoDir(options.repoDir);
  await resolveDatastoreForRepo(repoDir);
  const libCtx = createLibSwampContext();

  if (options.repair) {
    const deps = await createRepairDeps(repoDir);
    const renderer = createRepairDatastoresRenderer(cliCtx.outputMode);

    await consumeStream(
      repairDatastoreContamination(libCtx, deps, {
        confirm: Boolean(options.yes),
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("doctor datastores repair completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
    return;
  }

  const deps = await createDoctorDatastoresDeps(repoDir);
  const renderer = createDoctorDatastoresRenderer(cliCtx.outputMode);

  await consumeStream(
    doctorDatastores(libCtx, deps),
    renderer.handlers(),
  );

  cliCtx.logger.debug("doctor datastores command completed");

  if (renderer.overallStatus === "fail") {
    Deno.exit(1);
  }
});
