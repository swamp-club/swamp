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
  type DatastoreConfig,
  getDatastoreDirectories,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the datastore status output.
 */
export interface DatastoreStatusData {
  type: string;
  path?: string;
  healthy: boolean;
  message: string;
  latencyMs: number;
  directories: string[];
  exclude?: string[];
}

export type DatastoreStatusEvent =
  | { kind: "completed"; data: DatastoreStatusData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the datastore status operation. */
export interface DatastoreStatusDeps {
  loadConfig: () => DatastoreConfig;
  verifyHealth: (
    config: DatastoreConfig,
  ) => Promise<{ healthy: boolean; message: string; latencyMs: number }>;
  getDirectories: (config: DatastoreConfig) => string[];
}

/** Wires real infrastructure into DatastoreStatusDeps. */
export async function createDatastoreStatusDeps(
  datastoreResolver: DatastorePathResolver,
): Promise<DatastoreStatusDeps> {
  await datastoreTypeRegistry.ensureLoaded();
  return {
    loadConfig: () => datastoreResolver.config(),
    verifyHealth: async (config: DatastoreConfig) => {
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
          message: "No provider available",
          latencyMs: 0,
        };
      } else {
        const verifier = new FilesystemDatastoreVerifier(config.path);
        return await verifier.verify();
      }
    },
    getDirectories: (config: DatastoreConfig) => [
      ...getDatastoreDirectories(config),
    ],
  };
}

/** Returns datastore configuration and health status. */
export async function* datastoreStatus(
  ctx: LibSwampContext,
  deps: DatastoreStatusDeps,
): AsyncIterable<DatastoreStatusEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.status",
    {},
    (async function* () {
      ctx.logger.debug`Executing datastore status`;

      const config = deps.loadConfig();
      const directories = deps.getDirectories(config);
      const { healthy, message, latencyMs } = await deps.verifyHealth(config);

      const data: DatastoreStatusData = {
        type: config.type,
        path: !isCustomDatastoreConfig(config) ? config.path : undefined,
        healthy,
        message,
        latencyMs,
        directories,
        exclude: config.exclude,
      };

      ctx.logger.debug`Datastore status complete`;

      yield { kind: "completed", data };
    })(),
  );
}
