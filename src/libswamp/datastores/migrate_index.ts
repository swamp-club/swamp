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

import {
  isCustomDatastoreConfig,
  resolveSyncTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { MigrateIndexResult } from "../../domain/datastore/datastore_sync_service.ts";
import { runBoundedSync } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export type { MigrateIndexResult };

export interface MigrateIndexData {
  version: number;
  partitions: string[];
  commitSeq: number;
}

export type MigrateIndexEvent =
  | { kind: "migrating" }
  | { kind: "completed"; data: MigrateIndexData }
  | { kind: "not_supported"; message: string }
  | { kind: "error"; error: SwampError };

export interface MigrateIndexDeps {
  validateMigrationSupport: () => Promise<{
    supported: boolean;
    type: string;
    errorMessage?: string;
  }>;
  migrateIndex: () => Promise<MigrateIndexResult>;
}

export interface CreateMigrateIndexDepsOptions {
  readonly syncTimeoutMsOverride?: number;
}

export async function createMigrateIndexDeps(
  repoDir: string,
  datastoreResolver: DatastorePathResolver,
  options: CreateMigrateIndexDepsOptions = {},
): Promise<MigrateIndexDeps> {
  await datastoreTypeRegistry.ensureLoaded();
  const config = datastoreResolver.config();

  if (!isCustomDatastoreConfig(config)) {
    return makeUnsupportedDeps(
      config.type,
      "Index migration is only available for sync-capable custom datastores. " +
        `Current datastore type: ${config.type}`,
    );
  }

  await datastoreTypeRegistry.ensureTypeLoaded(config.type);
  const typeInfo = datastoreTypeRegistry.get(config.type);
  if (!typeInfo?.createProvider) {
    return makeUnsupportedDeps(
      config.type,
      `Datastore type "${config.type}" has no provider.`,
    );
  }

  const provider = typeInfo.createProvider(config.config);
  if (!provider.createSyncService) {
    return makeUnsupportedDeps(
      config.type,
      `Datastore type "${config.type}" does not support sync operations.`,
    );
  }

  if (!config.cachePath) {
    return makeUnsupportedDeps(
      config.type,
      `Datastore type "${config.type}" has no cache path configured.`,
    );
  }

  const syncService = provider.createSyncService(repoDir, config.cachePath);
  if (!syncService.migrateMonolithToShards) {
    return makeUnsupportedDeps(
      config.type,
      `Datastore type "${config.type}" does not support index migration. ` +
        `Update your datastore extension to a version that supports ` +
        `shard-first indexing.`,
    );
  }

  const timeoutMs = resolveSyncTimeoutMs(
    config,
    options.syncTimeoutMsOverride,
  );
  const label = config.type;
  const ns = config.namespace;

  return {
    validateMigrationSupport: () =>
      Promise.resolve({ supported: true, type: config.type }),
    migrateIndex: async () => {
      const result = await runBoundedSync(
        label,
        "push",
        timeoutMs,
        (signal) =>
          syncService.migrateMonolithToShards!({
            signal,
            ...(ns ? { namespace: ns } : {}),
          }),
      );
      return result as MigrateIndexResult;
    },
  };
}

function makeUnsupportedDeps(
  type: string,
  errorMessage: string,
): MigrateIndexDeps {
  return {
    validateMigrationSupport: () =>
      Promise.resolve({ supported: false, type, errorMessage }),
    migrateIndex: (): never => {
      throw new Error(errorMessage);
    },
  };
}

export async function* datastoreMigrateIndex(
  ctx: LibSwampContext,
  deps: MigrateIndexDeps,
): AsyncIterable<MigrateIndexEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.migrate_index.command",
    {},
    (async function* () {
      ctx.logger.debug`Executing datastore migrate-index command`;

      const validation = await deps.validateMigrationSupport();
      if (!validation.supported) {
        yield {
          kind: "not_supported",
          message: validation.errorMessage ??
            `Datastore type "${validation.type}" does not support index migration.`,
        };
        return;
      }

      yield { kind: "migrating" };

      const result = await deps.migrateIndex();
      yield {
        kind: "completed",
        data: {
          version: result.version,
          partitions: result.partitions,
          commitSeq: result.commitSeq,
        },
      };
    })(),
  );
}
