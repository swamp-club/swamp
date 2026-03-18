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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  getDatastoreDirectories,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { S3DatastoreVerifier } from "../../infrastructure/persistence/s3_datastore_verifier.ts";
import {
  type DatastoreStatusData,
  renderDatastoreStatus,
} from "../../presentation/output/datastore_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Shows current datastore configuration and health.
 */
export const datastoreStatusCommand = new Command()
  .description("Show datastore configuration and health")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "datastore",
      "status",
    ]);

    const { datastoreResolver } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    const config = datastoreResolver.config();
    const directories = [...getDatastoreDirectories(config)];

    // Verify health
    let healthy = false;
    let message = "Unknown";
    let latencyMs = 0;

    if (isCustomDatastoreConfig(config)) {
      const typeInfo = datastoreTypeRegistry.get(config.type);
      if (typeInfo?.createProvider) {
        const provider = typeInfo.createProvider(config.config);
        const verifier = provider.createVerifier();
        const result = await verifier.verify();
        healthy = result.healthy;
        message = result.message;
        latencyMs = result.latencyMs;
      }
    } else if (config.type === "filesystem") {
      const verifier = new FilesystemDatastoreVerifier(config.path);
      const result = await verifier.verify();
      healthy = result.healthy;
      message = result.message;
      latencyMs = result.latencyMs;
    } else {
      const verifier = new S3DatastoreVerifier(
        config.bucket,
        config.prefix,
        config.region,
      );
      const result = await verifier.verify();
      healthy = result.healthy;
      message = result.message;
      latencyMs = result.latencyMs;
    }

    const data: DatastoreStatusData = {
      type: config.type,
      path: !isCustomDatastoreConfig(config) && config.type === "filesystem"
        ? config.path
        : undefined,
      bucket: !isCustomDatastoreConfig(config) && config.type === "s3"
        ? config.bucket
        : undefined,
      prefix: !isCustomDatastoreConfig(config) && config.type === "s3"
        ? config.prefix
        : undefined,
      region: !isCustomDatastoreConfig(config) && config.type === "s3"
        ? config.region
        : undefined,
      healthy,
      message,
      latencyMs,
      directories,
      exclude: config.exclude,
    };

    renderDatastoreStatus(data, ctx.outputMode);
  });
