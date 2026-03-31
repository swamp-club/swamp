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

import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the datastore sync output.
 */
export interface DatastoreSyncData {
  mode: "push" | "pull" | "sync";
  filesPushed?: number;
  filesPulled?: number;
  errors?: string[];
}

export type DatastoreSyncEvent =
  | { kind: "syncing"; mode: "push" | "pull" | "sync" }
  | { kind: "completed"; data: DatastoreSyncData }
  | { kind: "error"; error: SwampError };

export interface DatastoreSyncInput {
  mode: "push" | "pull" | "sync";
}

/** Dependencies for the datastore sync operation. */
export interface DatastoreSyncDeps {
  validateSyncSupport: () => Promise<{
    supported: boolean;
    type: string;
    errorMessage?: string;
  }>;
  pushSync: () => Promise<{ filesPushed: number }>;
  pullSync: () => Promise<{ filesPulled: number }>;
  fullSync: () => Promise<{
    filesPulled: number;
    filesPushed: number;
    errors: string[];
  }>;
}

/** Wires real infrastructure into DatastoreSyncDeps. */
export function createDatastoreSyncDeps(
  repoDir: string,
  datastoreResolver: DatastorePathResolver,
): DatastoreSyncDeps {
  const config = datastoreResolver.config();

  if (isCustomDatastoreConfig(config)) {
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
        `Datastore type "${config.type}" does not support sync operations. ` +
          `Only lock-based operations are available.`,
      );
    }
    if (!config.cachePath) {
      return makeUnsupportedDeps(
        config.type,
        `Datastore type "${config.type}" has no cache path configured for sync.`,
      );
    }
    const syncService = provider.createSyncService(repoDir, config.cachePath);
    return {
      validateSyncSupport: () =>
        Promise.resolve({ supported: true, type: config.type }),
      pushSync: async () => {
        const count = await syncService.pushChanged();
        return { filesPushed: typeof count === "number" ? count : 0 };
      },
      pullSync: async () => {
        const count = await syncService.pullChanged();
        return { filesPulled: typeof count === "number" ? count : 0 };
      },
      fullSync: async () => {
        const pulled = await syncService.pullChanged();
        const pushed = await syncService.pushChanged();
        return {
          filesPulled: typeof pulled === "number" ? pulled : 0,
          filesPushed: typeof pushed === "number" ? pushed : 0,
          errors: [],
        };
      },
    };
  }

  return makeUnsupportedDeps(
    config.type,
    "Datastore sync is only available for sync-capable custom datastores. " +
      `Current datastore type: ${config.type}`,
  );
}

function makeUnsupportedDeps(
  type: string,
  errorMessage: string,
): DatastoreSyncDeps {
  const reject = () =>
    Promise.resolve({
      supported: false,
      type,
      errorMessage,
    });
  const fail = (): never => {
    throw new Error(errorMessage);
  };
  return {
    validateSyncSupport: reject,
    pushSync: fail,
    pullSync: fail,
    fullSync: fail,
  };
}

/** Syncs data between local cache and remote datastore. */
export async function* datastoreSync(
  ctx: LibSwampContext,
  deps: DatastoreSyncDeps,
  input: DatastoreSyncInput,
): AsyncIterable<DatastoreSyncEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.sync.command",
    {},
    (async function* () {
      ctx.logger.debug`Executing datastore sync in ${input.mode} mode`;

      const validation = await deps.validateSyncSupport();
      if (!validation.supported) {
        yield {
          kind: "error",
          error: {
            code: "sync_not_supported",
            message: validation.errorMessage ??
              `Datastore type "${validation.type}" does not support sync.`,
          },
        };
        return;
      }

      yield { kind: "syncing", mode: input.mode };

      if (input.mode === "push") {
        const result = await deps.pushSync();
        yield {
          kind: "completed",
          data: { mode: "push", filesPushed: result.filesPushed },
        };
      } else if (input.mode === "pull") {
        const result = await deps.pullSync();
        yield {
          kind: "completed",
          data: { mode: "pull", filesPulled: result.filesPulled },
        };
      } else {
        const result = await deps.fullSync();
        yield {
          kind: "completed",
          data: {
            mode: "sync",
            filesPulled: result.filesPulled,
            filesPushed: result.filesPushed,
            errors: result.errors,
          },
        };
      }
    })(),
  );
}
