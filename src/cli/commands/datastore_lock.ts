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
  createDatastoreLock,
  createModelLock,
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import { resolveCustomProvider } from "../../infrastructure/persistence/datastore_global_lock.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { UserError } from "../../domain/errors.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createDatastoreLockReleaseDeps,
  createDatastoreLockStatusDeps,
  type CustomModelLockSource,
  datastoreLockRelease,
  datastoreLockStatus,
  parseModelSpec,
} from "../../libswamp/datastores/lock.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { v3WriterLockHandle } from "../../infrastructure/datastore_v3/v3_writer_lock.ts";
import { v3DatastoreConfigOf } from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import { lockingConfigOf } from "../../infrastructure/persistence/datastore_lock_target.ts";
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

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig: config, engine } = await resolveDatastoreForRepo(
      repoDir,
    );

    // A v3 datastore's lock that matters across processes is its writer
    // lock (swamp-club#3279); a bucket datastore's is in its control plane,
    // found through its local root (swamp-club#3534).
    const v3 = engine === "v3"
      ? await v3DatastoreConfigOf(repoDir, config)
      : undefined;
    const lock = v3 !== undefined
      ? v3WriterLockHandle(v3.path)
      : await createDatastoreLock(config);

    // A bucket has no lock files to walk, so each model's lock is built the
    // way acquireModelLocks builds it and inspected (swamp-club#3372). A v3
    // bucket datastore's model locks are file locks under its local root.
    let customModelLocks: CustomModelLockSource | undefined;
    if (isCustomDatastoreConfig(config) && v3 === undefined) {
      const provider = await resolveCustomProvider(config);
      // Under managedConfig the definitions live in the datastore; pull them
      // so a model another clone created since the last sync is listed.
      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir,
        outputMode: cliCtx.outputMode,
        pull: true,
      });
      const definitionRepo = repoContext.definitionRepo;
      customModelLocks = {
        listModels: async () =>
          (definitionRepo.findAllIncludingAutoGlobal
            ? await definitionRepo.findAllIncludingAutoGlobal()
            : await definitionRepo.findAllGlobal()).map((
              { definition, type },
            ) => ({ modelType: type.normalized, modelId: definition.id })),
        createLock: (lockKey) =>
          provider.createLock(config.datastorePath, { lockKey }),
      };
    }
    const deps = createDatastoreLockStatusDeps(
      lock,
      lockingConfigOf(config),
      customModelLocks,
    );

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
    "Release a behavior lock",
    "swamp datastore lock release --force --behavior aws-ec2/my-server",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--force", "Required to confirm force release", { required: true })
  .option(
    "--behavior, --model <behavior:string>",
    "Release a specific behavior's lock (type/id format, e.g. aws-ec2/my-server)",
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

    const repoDir = resolveRepoDir(options.repoDir);
    const { datastoreConfig: config, engine } = await resolveDatastoreForRepo(
      repoDir,
    );
    const v3 = engine === "v3"
      ? await v3DatastoreConfigOf(repoDir, config)
      : undefined;

    const modelSpec = options.behavior as string | undefined;

    let lock;
    if (modelSpec) {
      const parsed = parseModelSpec(modelSpec);
      if (!parsed) {
        throw new UserError(
          `Invalid --model format: "${modelSpec}". Expected "type/id" ` +
            `(e.g. aws-ec2/my-server, or @org/name/my-server for scoped extension types).`,
        );
      }
      lock = await createModelLock(config, parsed.modelType, parsed.modelId);
    } else if (v3 !== undefined) {
      lock = v3WriterLockHandle(v3.path);
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
