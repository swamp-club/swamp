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
  createDatastoreSyncDeps,
  createLibSwampContext,
  datastoreSync,
} from "../../libswamp/mod.ts";
import { createDatastoreSyncRenderer } from "../../presentation/renderers/datastore_sync.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createCatalogStore,
  writeCatalogExport,
} from "../../infrastructure/persistence/repository_factory.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Upper bound on the `--timeout` flag in seconds. Six hours is generous
 * enough for realistic one-off scenarios (initial seeding from a slow link,
 * bulk recovery after an outage, 100k-file repo moves) while still rejecting
 * effectively-unbounded misconfigs (`--timeout 99999999`).
 *
 * The env var (`SWAMP_DATASTORE_SYNC_TIMEOUT_MS`) is intentionally
 * uncapped because it is shell-session-scoped knob for operators who know
 * what they want; the CLI flag is a one-off user-facing override and is
 * worth guarding against fat-fingered values.
 */
const SYNC_TIMEOUT_CLI_MAX_SECONDS = 21_600;

/**
 * Validate and normalize the `--timeout` CLI flag. Cliffy parses
 * `--timeout <seconds:integer>` as a number; we reject non-positive and
 * out-of-range values here so the user sees a clean `UserError` at the
 * CLI boundary rather than a confusing coordinator timeout surprise.
 *
 * Exported for unit tests; not part of the public CLI surface.
 */
export function parseTimeoutFlag(raw: unknown): number {
  if (
    typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)
  ) {
    throw new UserError(
      `--timeout must be a positive integer (seconds); got ${String(raw)}`,
    );
  }
  if (raw <= 0) {
    throw new UserError(
      `--timeout must be greater than 0; got ${raw}`,
    );
  }
  if (raw > SYNC_TIMEOUT_CLI_MAX_SECONDS) {
    throw new UserError(
      `--timeout must be at most ${SYNC_TIMEOUT_CLI_MAX_SECONDS} seconds ` +
        `(6 hours); got ${raw}. For higher values, set the ` +
        `SWAMP_DATASTORE_SYNC_TIMEOUT_MS env var instead.`,
    );
  }
  return raw * 1000;
}

/**
 * Manual sync command for S3 datastores.
 */
export const datastoreSyncCommand = new Command()
  .description("Sync local cache with S3 datastore")
  .example("Full sync", "swamp datastore sync")
  .example("Pull only", "swamp datastore sync --pull")
  .example("Push only", "swamp datastore sync --push")
  .example("Large one-off sync", "swamp datastore sync --timeout 1800")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--pull", "Pull-only mode (fetch all remote data to local cache)")
  .option("--push", "Push-only mode (upload all local cache data to S3)")
  .option(
    "--timeout <seconds:integer>",
    "Override the per-direction sync timeout for this invocation (seconds, " +
      "max 21600). Wins over SWAMP_DATASTORE_SYNC_TIMEOUT_MS and per-datastore " +
      "config. Preferred escape hatch for one-off large syncs.",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "sync",
    ]);
    cliCtx.logger.debug("Executing datastore sync command");

    const syncTimeoutMsOverride = options.timeout != null
      ? parseTimeoutFlag(options.timeout)
      : undefined;

    const mode = options.push
      ? "push" as const
      : options.pull
      ? "pull" as const
      : "sync" as const;

    // Pull-only mode uses read-only init (no lock). Push and default
    // modes use skipImplicitSync — see RequireRepoOptions JSDoc.
    const { repoDir, datastoreResolver } = mode === "pull"
      ? await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      })
      : await requireInitializedRepo({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
        skipImplicitSync: true,
      });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createDatastoreSyncDeps(repoDir, datastoreResolver, {
      syncTimeoutMsOverride,
    });
    const renderer = createDatastoreSyncRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreSync(ctx, deps, { mode }),
      renderer.handlers(),
    );

    if (mode === "pull" || mode === "sync") {
      const catalogStore = createCatalogStore(repoDir, datastoreResolver);
      catalogStore.invalidate();
      catalogStore.close();
    }

    if (mode === "push" || mode === "sync") {
      const config = datastoreResolver.config();
      const ns = config.namespace;
      if (ns && isCustomDatastoreConfig(config) && config.cachePath) {
        const catalogStore = createCatalogStore(repoDir, datastoreResolver);
        try {
          const exportCount = await writeCatalogExport(
            catalogStore,
            config.cachePath,
            ns,
          );
          await datastoreTypeRegistry.ensureLoaded();
          await datastoreTypeRegistry.ensureTypeLoaded(config.type);
          const typeInfo = datastoreTypeRegistry.get(config.type);
          const provider = typeInfo?.createProvider?.(config.config);
          const syncService = provider?.createSyncService?.(
            repoDir,
            config.cachePath,
          );
          if (syncService) {
            await syncService.markDirty({
              relPath: `${ns}/.catalog-export.json`,
            });
            await syncService.pushChanged({ namespace: ns });
            cliCtx.logger.info(
              "Exported catalog ({count} row(s)) for namespace {namespace}",
              { count: exportCount, namespace: ns },
            );
          }
        } catch (error) {
          cliCtx.logger.warn(
            "Catalog export failed (data push succeeded): {error}",
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
        } finally {
          catalogStore.close();
        }
      }
    }

    cliCtx.logger.debug("Datastore sync command completed");
  });
