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
import {
  createDatastoreLock,
  requireInitializedRepo,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  type DatastoreLockStatusData,
  renderDatastoreLockRelease,
  renderDatastoreLockStatus,
} from "../../presentation/output/datastore_output.ts";
import { S3Client } from "../../infrastructure/persistence/s3_client.ts";
import { join } from "@std/path";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Shows the current datastore lock status.
 */
const datastoreLockStatusCommand = new Command()
  .description("Show who holds the datastore lock")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "datastore",
      "lock",
      "status",
    ]);

    const { datastoreResolver } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    const config = datastoreResolver.config();
    const lock = createDatastoreLock(config);
    const info = await lock.inspect();

    const data: DatastoreLockStatusData = {
      held: info !== null,
      info: info ?? undefined,
      datastoreType: config.type,
    };

    renderDatastoreLockStatus(data, ctx.outputMode);
  });

/**
 * Force-releases a stuck datastore lock.
 */
const datastoreLockReleaseCommand = new Command()
  .description("Force-release a stuck datastore lock")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--force", "Required to confirm force release", { required: true })
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "datastore",
      "lock",
      "release",
    ]);

    if (!options.force) {
      throw new UserError(
        "The --force flag is required to release a lock. " +
          "This is a breakglass operation — only use it when a lock is stuck.",
      );
    }

    const { datastoreResolver } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    const config = datastoreResolver.config();
    const lock = createDatastoreLock(config);
    const info = await lock.inspect();

    if (!info) {
      renderDatastoreLockRelease(
        { released: false, reason: "no lock held" },
        ctx.outputMode,
      );
      return;
    }

    // Re-verify the lock holder hasn't changed between inspect and delete.
    // This guards against deleting a legitimately acquired lock.
    if (config.type === "s3") {
      const s3 = new S3Client({
        bucket: config.bucket,
        prefix: config.prefix,
        region: config.region,
      });
      const recheck = await lock.inspect();
      if (recheck?.nonce !== info.nonce) {
        renderDatastoreLockRelease(
          {
            released: false,
            reason:
              "lock holder changed — aborting to avoid breaking an active lock",
          },
          ctx.outputMode,
        );
        return;
      }
      await s3.deleteObject(".datastore.lock");
    } else {
      const lockPath = join(config.path, ".datastore.lock");
      const recheck = await lock.inspect();
      if (recheck?.nonce !== info.nonce) {
        renderDatastoreLockRelease(
          {
            released: false,
            reason:
              "lock holder changed — aborting to avoid breaking an active lock",
          },
          ctx.outputMode,
        );
        return;
      }
      try {
        await Deno.remove(lockPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    renderDatastoreLockRelease(
      { released: true, previousHolder: info },
      ctx.outputMode,
    );
  });

/**
 * Parent command group for datastore lock operations.
 */
export const datastoreLockCommand = new Command()
  .description("Manage datastore locks")
  .command("status", datastoreLockStatusCommand)
  .command("release", datastoreLockReleaseCommand);
