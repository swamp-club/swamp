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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  type DatastoreResolutionResult,
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  serveFingerprint,
  type ServeFingerprintEvent,
} from "../../libswamp/serve/fingerprint.ts";
import type { FingerprintDatastoreFacts } from "../../domain/serve/fingerprint_collector.ts";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import { resolveCustomProvider } from "../../infrastructure/persistence/datastore_global_lock.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import {
  loadServeConfig,
  mergeServeOptions,
} from "../../serve/serve_config.ts";
import { renderServeFingerprint } from "../../presentation/output/serve_fingerprint_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * a v3 extension datastore has a control plane by construction; a v2 one is
 * asked through its provider, which is read and never synced or locked
 */
export async function fingerprintDatastoreFacts(
  resolution: Pick<DatastoreResolutionResult, "datastoreConfig" | "engine">,
  repoDir: string,
  resolveProvider: (
    config: CustomDatastoreConfig,
  ) => Promise<DatastoreProvider> = resolveCustomProvider,
): Promise<FingerprintDatastoreFacts> {
  const { datastoreConfig, engine } = resolution;
  const format = engine === "v3" ? "v3" : "v2";
  if (!isCustomDatastoreConfig(datastoreConfig)) {
    return { customType: undefined, format, hasControlPlane: false };
  }
  if (engine === "v3") {
    return { customType: datastoreConfig.type, format, hasControlPlane: true };
  }
  try {
    const provider = await resolveProvider(datastoreConfig);
    const syncService = datastoreConfig.cachePath !== undefined
      ? provider.createSyncService?.(repoDir, datastoreConfig.cachePath)
      : undefined;
    return {
      customType: datastoreConfig.type,
      format,
      hasControlPlane: !!syncService?.capabilities?.().controlPlane,
    };
  } catch (error) {
    throw new UserError(
      `Cannot read the capabilities of datastore ${datastoreConfig.type}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export const serveFingerprintCommand = new Command()
  .name("fingerprint")
  .description(
    "Print this serve's fingerprint: the allowlisted facts it reports about itself.\n\n" +
      "Reads the serve config, datastore, vaults, extension lockfile and worker " +
      "records the same way 'swamp serve' does, without starting a server or " +
      "syncing the datastore. The hash covers configuration only: the worker pool " +
      "and runtime facts are printed but left out of it. Hostnames, addresses, " +
      "paths, usernames, grants and secrets are never included.",
  )
  .example("Print the fingerprint", "swamp serve fingerprint")
  .example(
    "Fingerprint a config file before deploying it",
    "swamp serve fingerprint --config deploy/serve.yaml --json",
  )
  .option(
    "--config <path:string>",
    "Path to serve config file (default: .swamp/serve.yaml; a relative path resolves against the repository)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "serve",
      "fingerprint",
    ]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const configFile = loadServeConfig(
      options.config as string | undefined,
      repoDir,
    );
    const merged = mergeServeOptions(configFile, {}, new Set());
    const { repoContext, lockfilePath } = await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });
    const resolution = await resolveDatastoreForRepo(repoDir);

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    await consumeStream(
      serveFingerprint(libCtx, {
        buildVersion: () => VERSION,
        platform: () => ({ platform: Deno.build.os, arch: Deno.build.arch }),
        settings: () => merged,
        serveYamlVersion: () => configFile?.version ?? 1,
        federationRole: () =>
          merged.federation?.role === "hub"
            ? "hub"
            : merged.federation?.hub !== undefined
            ? "member"
            : "none",
        datastore: () =>
          fingerprintDatastoreFacts(resolution, resolution.repoDir),
        vaultTypes: async () =>
          (await new YamlVaultConfigRepository(resolution.repoDir).findAll())
            .map((vault) => vault.type),
        extensions: async () =>
          Object.entries(
            (await LockfileRepository.create(lockfilePath)).getAllEntries(),
          ).map(([name, entry]) => ({ name, version: entry.version })),
        queryData: async (predicate) =>
          await repoContext.dataQueryService.query(predicate, {
            loadAttributes: true,
          }) as DataRecord[],
      }),
      withDefaults<ServeFingerprintEvent>({
        completed: (event) => {
          renderServeFingerprint(event.data, cliCtx.outputMode);
        },
        error: (event) => {
          throw new UserError(event.error.message);
        },
      }),
    );
  });
