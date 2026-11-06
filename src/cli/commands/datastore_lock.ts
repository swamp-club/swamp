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

import { requestServerResponse, ServerResponseError } from "../remote_run.ts";
import type { ModelGetResponse } from "../../serve/protocol.ts";
import type { ServeUpstreamTarget } from "../../domain/datastore_v3/serve_upstream.ts";
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
import {
  findDefinitionByIdOrName,
  isUuid,
} from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type ServeDatastoreClient,
  serveDatastoreClientFor,
} from "../../infrastructure/datastore_v3/serve_datastore_client.ts";
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
    "Release a specific behavior's lock, by its name or as type/id (e.g. my-server or aws-ec2/<id>; --model is the kept legacy spelling)",
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

    // binds a v3 bucket's lock config, which a behavior's lock needs too
    const v3 = engine === "v3" && resolution.serveUpstream === undefined
      ? await v3DatastoreConfigOf(repoDir, config)
      : undefined;

    let lock;
    if (modelSpec) {
      // type/id, type/name, or a bare name or id, as other --behavior options
      const parsed = parseModelSpec(modelSpec);
      // a checkout written through serve asks serve to end the lease on the
      // behavior, whoever holds it: admin only.
      if (resolution.serveUpstream !== undefined) {
        // An id needs no definition lookup, and a name is looked up at serve,
        // so the checkout's copy is never opened: rebuilding it for this
        // caller would wait for a running command's writer lock, and with it
        // for the very lease to end.
        if (parsed !== null && isUuid(parsed.modelId)) {
          await releaseServeLeaseById(
            cliCtx,
            serveDatastoreClientFor(
              resolution.serveUpstream,
              config.namespace ?? "",
            ),
            parsed.modelType,
            parsed.modelId,
          );
          return;
        }
        const nameOrId = parsed?.modelId ?? modelSpec;
        const found = await behaviorAtServe(
          resolution.serveUpstream,
          nameOrId,
        );
        if (found === undefined) throw behaviorNotFound(modelSpec);
        // The type the spec names must be the behavior's: a wrong type
        // never ends the lease of another behavior with that name.
        if (
          parsed !== null && !modelSpecTypeMatches(parsed.modelType, found.type)
        ) {
          throw new UserError(
            `Behavior ${parsed.modelId} is of type ${found.type}, ` +
              `not ${parsed.modelType}: nothing was released. ` +
              `Pass --behavior ${found.type}/${parsed.modelId}.`,
          );
        }
        await releaseServeLeaseById(
          cliCtx,
          serveDatastoreClientFor(
            resolution.serveUpstream,
            config.namespace ?? "",
          ),
          found.type,
          found.id,
        );
        return;
      }
      if (parsed === null) {
        const { repoContext } = await requireInitializedRepoReadOnly({
          repoDir,
          outputMode: cliCtx.outputMode,
        });
        const found = await findDefinitionByIdOrName(
          repoContext.definitionRepo,
          modelSpec,
        );
        if (found === null || found === undefined) {
          throw behaviorNotFound(modelSpec);
        }
        lock = await createModelLock(
          config,
          found.type.normalized,
          found.definition.id,
        );
      } else {
        lock = await createModelLock(
          config,
          parsed.modelType,
          parsed.modelId,
        );
      }
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

export const datastoreLockCommand = new Command()
  .description("Manage datastore locks")
  .command("status", datastoreLockStatusCommand)
  .command("release", datastoreLockReleaseCommand);

function behaviorNotFound(spec: string): UserError {
  return new UserError(
    `Behavior not found: ${spec}. Name it by its name, or by type/id ` +
      `(e.g. aws-ec2/<id>); nothing was released.`,
  );
}

/**
 * serve's model.get, under the caller's read grant: a behavior the caller may
 * not read is not found, like one that does not exist
 */
async function behaviorAtServe(
  target: ServeUpstreamTarget,
  nameOrId: string,
): Promise<{ type: string; id: string } | undefined> {
  let reply: ModelGetResponse;
  try {
    reply = await requestServerResponse<ModelGetResponse>(
      {
        server: target.serverUrl,
        ...(target.token === undefined ? {} : { token: target.token }),
        ...(target.caCerts === undefined
          ? {}
          : { caCerts: [...target.caCerts] }),
        headers: { ...target.extraHeaders },
      },
      { type: "model.get", payload: { modelIdOrName: nameOrId } },
    );
  } catch (error) {
    if (error instanceof ServerResponseError) return undefined;
    throw error;
  }
  const { type, id } = reply.data as { type?: unknown; id?: unknown };
  if (typeof type !== "string" || typeof id !== "string") return undefined;
  return { type, id };
}

async function releaseServeLeaseById(
  cliCtx: ReturnType<typeof createContext>,
  client: ServeDatastoreClient,
  specType: string,
  modelId: string,
): Promise<void> {
  let modelType: string;
  try {
    modelType = ModelType.create(specType).normalized;
  } catch {
    throw new UserError(
      `Invalid behavior type "${specType}": nothing was released.`,
    );
  }
  // serve keys a lease by the canonical, lowercase id
  const id = modelId.toLowerCase();
  const lockKey = modelLockKey(undefined, modelType, id);
  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const renderer = createDatastoreLockReleaseRenderer(cliCtx.outputMode);
  try {
    await consumeStream(
      datastoreLockRelease(
        ctx,
        createServeLeaseReleaseDeps(async () => {
          // Bounded by the client's own per-request timeout.
          const outcome = await client.forceReleaseLock(
            lockKey,
            new AbortController().signal,
          );
          if (!outcome.released) {
            await refuseWrongType(client, modelType, id);
          }
          return outcome;
        }),
        {},
      ),
      renderer.handlers(),
    );
  } finally {
    client.close();
  }
}

/**
 * a lease on the id under another type means the spec named the wrong type:
 * said as the definition lookup said it, so the admin can pass the right one
 */
async function refuseWrongType(
  client: ServeDatastoreClient,
  modelType: string,
  modelId: string,
): Promise<void> {
  const listing = await client.listLocks("data/", new AbortController().signal)
    .catch(() => undefined);
  for (const lease of listing?.leases ?? []) {
    const match = /^data\/(.+)\/([^/]+)\/\.lock$/.exec(lease.lockKey);
    if (match === null || match[2] !== modelId || match[1] === modelType) {
      continue;
    }
    throw new UserError(
      `Behavior ${modelId} is of type ${match[1]}, not ${modelType}: ` +
        `nothing was released. Pass --behavior ${match[1]}/${modelId}.`,
    );
  }
}
