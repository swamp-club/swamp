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
  createModelLock,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { UserError } from "../../domain/errors.ts";
import {
  type DatastoreLockReleaseData,
  type DatastoreLockStatusData,
  renderDatastoreLockRelease,
  renderDatastoreLockStatus,
} from "../../presentation/output/datastore_output.ts";
import { walk } from "@std/fs";
import { relative } from "@std/path";
import type { LockInfo } from "../../domain/datastore/distributed_lock.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Scans the datastore for per-model lock files.
 *
 * Returns an array of { lockKey, modelType, modelId, info } for each
 * found per-model lock. Only works for filesystem datastores.
 */
async function scanModelLocks(
  datastorePath: string,
): Promise<
  Array<{
    lockKey: string;
    modelType: string;
    modelId: string;
    info: LockInfo;
  }>
> {
  const results: Array<{
    lockKey: string;
    modelType: string;
    modelId: string;
    info: LockInfo;
  }> = [];

  try {
    for await (
      const entry of walk(datastorePath, {
        includeDirs: false,
        match: [/\.lock$/],
      })
    ) {
      const rel = relative(datastorePath, entry.path);
      // Match pattern: data/{modelType}/{modelId}/.lock
      const parts = rel.split("/");
      if (
        parts.length === 4 && parts[0] === "data" && parts[3] === ".lock"
      ) {
        try {
          const content = await Deno.readTextFile(entry.path);
          const info = JSON.parse(content) as LockInfo;
          results.push({
            lockKey: rel,
            modelType: parts[1],
            modelId: parts[2],
            info,
          });
        } catch {
          // Skip unreadable lock files
        }
      }
    }
  } catch {
    // Datastore directory may not exist
  }

  return results;
}

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

    const { datastoreConfig: config } = await resolveDatastoreForRepo(
      options.repoDir ?? ".",
    );

    // Check global lock
    const lock = createDatastoreLock(config);
    const info = await lock.inspect();

    const data: DatastoreLockStatusData = {
      held: info !== null,
      info: info ?? undefined,
      datastoreType: config.type,
    };

    renderDatastoreLockStatus(data, ctx.outputMode);

    // Scan for per-model locks (filesystem only)
    if (!isCustomDatastoreConfig(config) && config.type === "filesystem") {
      const modelLocks = await scanModelLocks(config.path);
      if (modelLocks.length > 0) {
        for (const ml of modelLocks) {
          const modelData: DatastoreLockStatusData = {
            held: true,
            info: ml.info,
            datastoreType: config.type,
            lockScope: `${ml.modelType}/${ml.modelId}`,
          };
          renderDatastoreLockStatus(modelData, ctx.outputMode);
        }
      }
    }
  });

/**
 * Force-releases a stuck datastore lock.
 */
const datastoreLockReleaseCommand = new Command()
  .description("Force-release a stuck datastore lock")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--force", "Required to confirm force release", { required: true })
  .option(
    "--model <model:string>",
    "Release a specific model's lock (type/id format, e.g. aws-ec2/my-server)",
  )
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

    const { datastoreConfig: config } = await resolveDatastoreForRepo(
      options.repoDir ?? ".",
    );

    const modelSpec = options.model as string | undefined;

    let lock;
    if (modelSpec) {
      // Per-model lock release
      const parts = modelSpec.split("/");
      if (parts.length !== 2) {
        throw new UserError(
          `Invalid --model format: "${modelSpec}". Expected "type/id" (e.g. aws-ec2/my-server).`,
        );
      }
      lock = createModelLock(config, parts[0], parts[1]);
    } else {
      // Global lock release
      lock = createDatastoreLock(config);
    }

    const info = await lock.inspect();

    if (!info) {
      const releaseData: DatastoreLockReleaseData = {
        released: false,
        reason: "no lock held",
      };
      renderDatastoreLockRelease(releaseData, ctx.outputMode);
      return;
    }

    // Re-verify the lock holder hasn't changed between inspect and delete.
    // forceRelease() re-reads the nonce immediately before deleting to
    // minimise the TOCTOU window.
    const released = await lock.forceRelease(info.nonce!);
    if (!released) {
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
