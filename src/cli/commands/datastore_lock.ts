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
  v3LocationOf,
} from "../repo_context.ts";
import { serveUpstreamAt } from "../../infrastructure/datastore_v3/serve_upstream_registry.ts";
import { resolveCustomProvider } from "../../infrastructure/persistence/datastore_global_lock.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { UserError } from "../../domain/errors.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createDatastoreLockReleaseDeps,
  createDatastoreLockStatusDeps,
  createServeLeaseReleaseDeps,
  createServeMemberLockReleaseDeps,
  createServeMemberLockStatusDeps,
  type CustomModelLockSource,
  datastoreLockRelease,
  datastoreLockStatus,
  modelLockKey,
  modelSpecTypeMatches,
  parseModelSpec,
} from "../../libswamp/datastores/lock.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
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
    const resolution = await resolveDatastoreForRepo(repoDir);
    const { datastoreConfig: config, engine } = resolution;
    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createDatastoreLockStatusRenderer(cliCtx.outputMode);

    // a checkout written through serve binds no storage and needs no
    // datastore extension: its locks are the leases serve holds.
    if (resolution.serveUpstream !== undefined) {
      const binding = serveUpstreamAt((await v3LocationOf(resolution)).path);
      if (binding === undefined) {
        throw new Error("Internal error: the serve upstream is not bound");
      }
      await consumeStream(
        datastoreLockStatus(
          ctx,
          createServeMemberLockStatusDeps(async () => {
            const client = binding.client();
            try {
              // Bounded by the client's own per-request timeout.
              return await client.listLocks("", new AbortController().signal);
            } finally {
              client.close();
            }
          }),
          { datastoreType: config.type, isFilesystemDatastore: false },
        ),
        renderer.handlers(),
      );
      return;
    }

    // a v3 datastore's cross-process lock is its writer lock; a bucket
    // datastore's is in its control plane, found through its local root.
    const v3 = engine === "v3"
      ? await v3DatastoreConfigOf(repoDir, config)
      : undefined;
    const lock = v3 !== undefined
      ? v3WriterLockHandle(v3.path)
      : await createDatastoreLock(config);

    // a bucket has no lock files to walk, so each model's lock is built as
    // acquireModelLocks builds it and inspected; a v3 bucket's model locks are
    // file locks under its local root.
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

    await consumeStream(
      datastoreLockStatus(ctx, deps, {
        datastoreType: config.type,
        isFilesystemDatastore: isFilesystem,
      }),
      renderer.handlers(),
    );
  });

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
  .option(
    "--force",
    "Required to confirm force release (not an alias for --yes)",
    { required: true },
  )
  .option(
    "--behavior, --model <behavior:string>",
    "Release a specific behavior's lock (type/id format, e.g. aws-ec2/my-server; --model is the kept legacy spelling)",
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
    const resolution = await resolveDatastoreForRepo(repoDir);
    const { datastoreConfig: config, engine } = resolution;

    const modelSpec = options.behavior as string | undefined;

    // a checkout written through serve has no datastore-wide lock to release:
    // serve's writer lease is serve's, and the caller's own leases end with
    // `model lease release` or, for an admin, --behavior.
    if (resolution.serveUpstream !== undefined && !modelSpec) {
      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const renderer = createDatastoreLockReleaseRenderer(cliCtx.outputMode);
      await consumeStream(
        datastoreLockRelease(ctx, createServeMemberLockReleaseDeps(), {}),
        renderer.handlers(),
      );
      if (cliCtx.outputMode === "log") {
        cliCtx.logger
          .info`This checkout writes through serve, which orders writers per behavior. To end a behavior's lease, run swamp model lease release <behavior>, or, as an admin, swamp datastore lock release --force --behavior <type/id>.`;
      }
      return;
    }

    let lock;
    if (modelSpec) {
      const parsed = parseModelSpec(modelSpec);
      if (!parsed) {
        throw new UserError(
          `Invalid --model format: "${modelSpec}". Expected "type/id" ` +
            `(e.g. aws-ec2/my-server, or @org/name/my-server for scoped extension types).`,
        );
      }
      // a checkout written through serve asks serve to end the lease on the
      // behavior, whoever holds it: admin only.
      if (resolution.serveUpstream !== undefined) {
        const binding = serveUpstreamAt(
          (await v3LocationOf(resolution)).path,
        );
        if (binding === undefined) {
          throw new Error("Internal error: the serve upstream is not bound");
        }
        const { repoContext } = await requireInitializedRepoReadOnly({
          repoDir,
          outputMode: cliCtx.outputMode,
        });
        const found = await findDefinitionByIdOrName(
          repoContext.definitionRepo,
          parsed.modelId,
        );
        if (found === null || found === undefined) {
          throw new UserError(`Behavior not found: ${modelSpec}`);
        }
        // The type the spec names must be the behavior's: a wrong type
        // never ends the lease of another behavior with that name.
        if (!modelSpecTypeMatches(parsed.modelType, found.type.normalized)) {
          throw new UserError(
            `Behavior ${parsed.modelId} is of type ${found.type.normalized}, ` +
              `not ${parsed.modelType}: nothing was released. ` +
              `Pass --behavior ${found.type.normalized}/${parsed.modelId}.`,
          );
        }
        const lockKey = modelLockKey(
          undefined,
          found.type.normalized,
          found.definition.id,
        );
        const ctx = createLibSwampContext({ logger: cliCtx.logger });
        const renderer = createDatastoreLockReleaseRenderer(cliCtx.outputMode);
        await consumeStream(
          datastoreLockRelease(
            ctx,
            createServeLeaseReleaseDeps(async () => {
              const client = binding.client();
              try {
                // Bounded by the client's own per-request timeout.
                return await client.forceReleaseLock(
                  lockKey,
                  new AbortController().signal,
                );
              } finally {
                client.close();
              }
            }),
            {},
          ),
          renderer.handlers(),
        );
        return;
      }
      lock = await createModelLock(config, parsed.modelType, parsed.modelId);
    } else if (engine === "v3") {
      lock = v3WriterLockHandle(
        (await v3DatastoreConfigOf(repoDir, config)).path,
      );
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

export const datastoreLockCommand = new Command()
  .description("Manage datastore locks")
  .command("status", datastoreLockStatusCommand)
  .command("release", datastoreLockReleaseCommand);
