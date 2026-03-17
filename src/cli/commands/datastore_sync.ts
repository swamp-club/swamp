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
import { requireInitializedRepo } from "../repo_context.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { UserError } from "../../domain/errors.ts";
import { S3CacheSyncService } from "../../infrastructure/persistence/s3_cache_sync.ts";
import { S3Client } from "../../infrastructure/persistence/s3_client.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Manual sync command for S3 datastores.
 */
export const datastoreSyncCommand = new Command()
  .description("Sync local cache with S3 datastore")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--pull", "Pull-only mode (fetch all remote data to local cache)")
  .option("--push", "Push-only mode (upload all local cache data to S3)")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "datastore",
      "sync",
    ]);

    const { repoDir, datastoreResolver } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    const config = datastoreResolver.config();

    // Handle custom datastore sync
    if (isCustomDatastoreConfig(config)) {
      const typeInfo = datastoreTypeRegistry.get(config.type);
      if (!typeInfo?.createProvider) {
        throw new UserError(
          `Datastore type "${config.type}" has no provider.`,
        );
      }
      const provider = typeInfo.createProvider(config.config);
      if (!provider.createSyncService) {
        throw new UserError(
          `Datastore type "${config.type}" does not support sync operations. ` +
            `Only lock-based operations are available.`,
        );
      }
      if (!config.cachePath) {
        throw new UserError(
          `Datastore type "${config.type}" has no cache path configured for sync.`,
        );
      }
      const syncService = provider.createSyncService(repoDir, config.cachePath);

      if (options.push) {
        ctx.logger.info`Pushing changes to datastore...`;
        await syncService.pushChanged();
        const data = { mode: "push" };
        if (ctx.outputMode === "json") {
          console.log(JSON.stringify(data, null, 2));
        } else {
          ctx.logger.info`Push complete`;
        }
      } else if (options.pull) {
        ctx.logger.info`Pulling from datastore...`;
        await syncService.pullChanged();
        const data = { mode: "pull" };
        if (ctx.outputMode === "json") {
          console.log(JSON.stringify(data, null, 2));
        } else {
          ctx.logger.info`Pull complete`;
        }
      } else {
        ctx.logger.info`Syncing with datastore...`;
        await syncService.pullChanged();
        await syncService.pushChanged();
        const data = { mode: "sync" };
        if (ctx.outputMode === "json") {
          console.log(JSON.stringify(data, null, 2));
        } else {
          ctx.logger.info`Sync complete`;
        }
      }
      return;
    }

    if (config.type !== "s3") {
      throw new UserError(
        "Datastore sync is only available for S3 or sync-capable custom datastores. " +
          `Current datastore type: ${config.type}`,
      );
    }

    const s3 = new S3Client({
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
    });
    const syncService = new S3CacheSyncService(s3, config.cachePath);

    if (options.push) {
      ctx.logger.info`Pushing all local data to S3...`;
      const count = await syncService.pushAll();
      const data = { mode: "push", filesPushed: count };

      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(data, null, 2));
      } else {
        ctx.logger.info`Pushed ${count} files to S3`;
      }
    } else if (options.pull) {
      ctx.logger.info`Pulling all data from S3...`;
      await syncService.pullIndex();
      const count = await syncService.pullAll();
      const data = { mode: "pull", filesPulled: count };

      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(data, null, 2));
      } else {
        ctx.logger.info`Pulled ${count} files from S3`;
      }
    } else {
      ctx.logger.info`Syncing with S3...`;
      const result = await syncService.sync();
      const data = {
        mode: "sync",
        filesPulled: result.filesPulled,
        filesPushed: result.filesPushed,
        errors: result.errors,
      };

      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(data, null, 2));
      } else {
        ctx.logger
          .info`Sync complete: ${result.filesPulled} pulled, ${result.filesPushed} pushed`;
        for (const err of result.errors) {
          ctx.logger.warn`${err}`;
        }
      }
    }
  });
