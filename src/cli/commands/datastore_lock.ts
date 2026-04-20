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
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  createDatastoreLock,
  createModelLock,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { UserError } from "../../domain/errors.ts";
import {
  consumeStream,
  createDatastoreLockReleaseDeps,
  createDatastoreLockStatusDeps,
  createLibSwampContext,
  datastoreLockRelease,
  datastoreLockStatus,
} from "../../libswamp/mod.ts";
import {
  createDatastoreLockReleaseRenderer,
  createDatastoreLockStatusRenderer,
} from "../../presentation/renderers/datastore_lock.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Shows the current datastore lock status.
 */
const datastoreLockStatusCommand = new Command()
  .description("Show who holds the datastore lock")
  .example("Check lock status", "swamp datastore lock status")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "lock",
      "status",
    ]);

    const { datastoreConfig: config } = await resolveDatastoreForRepo(
      resolveRepoDir(options.repoDir),
    );

    const lock = await createDatastoreLock(config);
    const deps = createDatastoreLockStatusDeps(lock, config);

    const isFilesystem = !isCustomDatastoreConfig(config) &&
      config.type === "filesystem";

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createDatastoreLockStatusRenderer(cliCtx.outputMode);

    await consumeStream(
      datastoreLockStatus(ctx, deps, {
        datastoreType: config.type,
        isFilesystemDatastore: isFilesystem,
      }),
      renderer.handlers(),
    );
  });

/**
 * Force-releases a stuck datastore lock.
 */
const datastoreLockReleaseCommand = new Command()
  .description("Force-release a stuck datastore lock")
  .example(
    "Release stuck datastore lock",
    "swamp datastore lock release --force",
  )
  .example(
    "Release a model lock",
    "swamp datastore lock release --force --model aws-ec2/my-server",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--force", "Required to confirm force release", { required: true })
  .option(
    "--model <model:string>",
    "Release a specific model's lock (type/id format, e.g. aws-ec2/my-server)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
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
      resolveRepoDir(options.repoDir),
    );

    const modelSpec = options.model as string | undefined;

    let lock;
    if (modelSpec) {
      const parts = modelSpec.split("/");
      if (parts.length !== 2) {
        throw new UserError(
          `Invalid --model format: "${modelSpec}". Expected "type/id" (e.g. aws-ec2/my-server).`,
        );
      }
      lock = await createModelLock(config, parts[0], parts[1]);
    } else {
      lock = await createDatastoreLock(config);
    }

    const deps = createDatastoreLockReleaseDeps(lock);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createDatastoreLockReleaseRenderer(cliCtx.outputMode);

    await consumeStream(
      datastoreLockRelease(ctx, deps, {}),
      renderer.handlers(),
    );
  });

/**
 * Parent command group for datastore lock operations.
 */
export const datastoreLockCommand = new Command()
  .description("Manage datastore locks")
  .command("status", datastoreLockStatusCommand)
  .command("release", datastoreLockReleaseCommand);
