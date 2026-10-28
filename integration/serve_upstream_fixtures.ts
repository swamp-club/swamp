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

/**
 * Fixtures for the serve-upstream integration tests (swamp-club#3985): a
 * serve over a real v3 repository in a Worker (`serve_upstream_server_worker.ts`),
 * and client checkouts opened the production way, through
 * `requireInitializedRepo*`, whose `.swamp.yaml` names a v3 datastore at a
 * path that does not exist, so any touch of the storage shows.
 */

import { join } from "@std/path";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  resetServeUpstreamCommandPath,
  setServeUpstreamCommandPath,
} from "../src/cli/serve_upstream.ts";
import { Data } from "../src/domain/data/data.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import type { DatastoreProvider } from "../src/domain/datastore/datastore_provider.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { resetServeUpstreamBindingsForTesting } from "../src/infrastructure/datastore_v3/serve_upstream_registry.ts";
import {
  initializeV3Datastore,
  resetStaleReadWarningForTesting,
  setV3DatastoreFaultsForTesting,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../src/cli/repo_context.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import type {
  GrantSpec,
  ServeLogEntry,
  ServeWorkerMessage,
  ServeWorkerRequest,
} from "./serve_upstream_server_worker.ts";
import { UNSET_ENV } from "./usecase_sync_fixtures.ts";

/**
 * A team member's grants: read, write and run every behavior, read and
 * write (so delete) its data.
 */
export const MEMBER: readonly GrantSpec[] = [
  { actions: ["read", "write", "run"], kind: "model", pattern: "*" },
  { actions: ["read", "write"], kind: "data", pattern: "*" },
];

/** A serve in a Worker, over a fresh v3 repository holding behavior `web`. */
export interface Serve {
  /** Serve's origin: what `SWAMP_SERVE_URL` names. */
  readonly origin: string;
  readonly modelType: ModelType;
  /** The behaviors serve's repo started with, by name: their ids. */
  readonly models: Readonly<Record<string, string>>;
  /** Serve's own checkout. */
  readonly serveRepo: string;
  /** Every commit of serve's log after its compaction point, in order. */
  log(): Promise<readonly ServeLogEntry[]>;
  /**
   * Compacts serve's whole log; with `claim`, serve claims its datastore
   * first. Resolves with the compaction point.
   */
  compact(options?: { claim?: boolean }): Promise<number>;
  /**
   * Serve's own work: `count` saves of `dataName` on `web`, each under
   * serve's lock on it, as serve's method runs take it.
   */
  write(
    dataName: string,
    dataId: string,
    count: number,
  ): Promise<{ versions: readonly number[]; errors: readonly string[] }>;
  stop(): Promise<void>;
}

/** A client checkout of the datastore serve writes. */
export interface Client {
  readonly repoDir: string;
  /**
   * Where a filesystem client's `.swamp.yaml` says the datastore's storage
   * is: never created.
   */
  readonly storagePath: string;
}

/**
 * A bucket datastore type no client may reach. Resolving `.swamp.yaml`
 * constructs its provider to name its paths, as every bucket's does; any
 * use of the provider past that (a lock, its storage, its control plane, a
 * sync service, a verifier) is recorded and throws.
 */
export interface UnreachableBucket {
  readonly typeName: string;
  /** The provider members something used past naming its paths. */
  readonly touched: () => readonly string[];
  dispose(): void;
}

/** Registers an {@link UnreachableBucket}. */
export function registerUnreachableBucket(): UnreachableBucket {
  const typeName = `@test/unreachable-${crypto.randomUUID()}`;
  const touched: string[] = [];
  const refuse = (member: string) => () => {
    touched.push(member);
    throw new Error(`the storage of ${typeName} was used: ${member}`);
  };
  datastoreTypeRegistry.register({
    type: typeName,
    name: "Unreachable bucket",
    description: "a bucket a serve-mode client must never open",
    isBuiltIn: false,
    createProvider: () =>
      ({
        resolveDatastorePath: (repoDir: string) =>
          join(repoDir, ".unreachable-store"),
        resolveCachePath: (repoDir: string) =>
          join(repoDir, ".unreachable-cache"),
        createLock: refuse("createLock"),
        createVerifier: refuse("createVerifier"),
        createSyncService: refuse("createSyncService"),
        storage: refuse("storage"),
        datastoreControlPlaneStore: refuse("datastoreControlPlaneStore"),
        replicaTarget: refuse("replicaTarget"),
        replicaPaths: refuse("replicaPaths"),
        registerNamespace: refuse("registerNamespace"),
        listNamespaces: refuse("listNamespaces"),
      }) as unknown as DatastoreProvider,
  });
  return {
    typeName,
    touched: () => [...touched],
    dispose: () => datastoreTypeRegistry.invalidateType(typeName),
  };
}

/** What {@link Scratch.serve} starts. */
export interface ServeOptions {
  readonly grants?: readonly GrantSpec[];
  /** Behaviors serve's repo holds besides `web`, by name. */
  readonly models?: readonly string[];
  /** Serve's datastore holds the repository's config. */
  readonly managedConfig?: boolean;
}

/** What {@link Scratch.client} creates. */
export interface ClientOptions {
  /** The marker's serverAddress. */
  readonly serverAddress?: string;
  /** The datastore is this bucket instead of a filesystem path. */
  readonly bucket?: UnreachableBucket;
  readonly managedConfig?: boolean;
  /**
   * A solo checkout: its filesystem datastore is created, and it is opened
   * without a serve address.
   */
  readonly solo?: boolean;
}

export interface Scratch {
  readonly dir: string;
  /** The swamp config dir every client reads servers.json from. */
  readonly configDir: string;
  serve(options?: ServeOptions): Promise<Serve>;
  /** An {@link UnreachableBucket}, disposed when the scratch ends. */
  bucket(): UnreachableBucket;
  client(name: string, options?: ClientOptions): Promise<Client>;
}

/** Starts serve in a Worker; see {@link Serve}. */
async function startServe(options: ServeOptions): Promise<Serve> {
  const worker = new Worker(
    new URL("./serve_upstream_server_worker.ts", import.meta.url).href,
    { type: "module" },
  );
  let loaded = false;
  let ready: Extract<ServeWorkerMessage, { kind: "ready" }> | undefined;
  let failed: string | undefined;
  let stopped = false;
  let logReply: readonly ServeLogEntry[] | undefined;
  let compactedPoint: number | undefined;
  let wroteReply:
    | { versions: readonly number[]; errors: readonly string[] }
    | undefined;
  worker.onmessage = (event: MessageEvent<ServeWorkerMessage>) => {
    const message = event.data;
    if (message.kind === "loaded") loaded = true;
    else if (message.kind === "ready") ready = message;
    else if (message.kind === "failed") failed = message.error;
    else if (message.kind === "stopped") stopped = true;
    else if (message.kind === "wrote") wroteReply = message;
    else if (message.kind === "compacted") compactedPoint = message.point;
    else logReply = message.entries;
  };
  worker.onerror = (event) => {
    event.preventDefault();
    failed = event.message;
  };
  try {
    // The worker loads its module graph first, which a loaded host can
    // stretch well past the default wait.
    await waitFor(
      () => loaded || failed !== undefined,
      "serve's worker to load",
      { timeoutMs: 120_000 },
    );
    worker.postMessage(
      {
        kind: "start",
        grants: options.grants ?? MEMBER,
        models: options.models ?? [],
        managedConfig: options.managedConfig === true,
      } satisfies ServeWorkerRequest,
    );
    await waitFor(
      () => ready !== undefined || failed !== undefined,
      "serve to start",
      { timeoutMs: 60_000 },
    );
  } catch (error) {
    worker.terminate();
    throw error;
  }
  if (ready === undefined) {
    worker.terminate();
    throw new Error(`serve failed to start: ${failed}`);
  }
  // The client's repositories resolve the behavior type in this thread.
  const modelType = ModelType.create(ready.modelType);
  modelRegistry.register({
    type: modelType,
    version: "2026.01.01.1",
    methods: {
      noop: {
        description: "does nothing",
        kind: "read",
        arguments: z.object({}),
        execute: () => Promise.resolve({}),
      },
    },
  });
  const started = ready;
  let terminated = false;
  return {
    origin: started.origin,
    modelType,
    models: started.models,
    serveRepo: started.serveRepo,
    async log() {
      logReply = undefined;
      worker.postMessage({ kind: "log" } satisfies ServeWorkerRequest);
      await waitFor(
        () => logReply !== undefined || failed !== undefined,
        "serve's log",
      );
      if (logReply === undefined) throw new Error(`serve failed: ${failed}`);
      return logReply;
    },
    async compact(options = {}) {
      compactedPoint = undefined;
      worker.postMessage(
        { kind: "compact", claim: options.claim } satisfies ServeWorkerRequest,
      );
      await waitFor(
        () => compactedPoint !== undefined || failed !== undefined,
        "serve's compaction",
      );
      if (compactedPoint === undefined) {
        throw new Error(`serve failed: ${failed}`);
      }
      return compactedPoint;
    },
    async write(dataName, dataId, count) {
      wroteReply = undefined;
      worker.postMessage(
        { kind: "write", dataName, dataId, count } satisfies ServeWorkerRequest,
      );
      await waitFor(
        () => wroteReply !== undefined || failed !== undefined,
        "serve's writes",
        { timeoutMs: 120_000 },
      );
      if (wroteReply === undefined) throw new Error(`serve failed: ${failed}`);
      return wroteReply;
    },
    async stop() {
      if (terminated) return;
      terminated = true;
      try {
        worker.postMessage({ kind: "stop" } satisfies ServeWorkerRequest);
        await waitFor(
          () => stopped || failed !== undefined,
          "serve to stop",
          { timeoutMs: 30_000 },
        );
      } finally {
        worker.terminate();
        modelRegistry.invalidateType(modelType);
      }
      if (failed !== undefined) throw new Error(`serve failed: ${failed}`);
    },
  };
}

/** A fresh checkout at `repoDir` whose datastore is v3 at `storagePath`. */
async function initClient(
  repoDir: string,
  storagePath: string,
  options: ClientOptions,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  const lines = [
    ...(options.serverAddress !== undefined
      ? [`serverAddress: ${JSON.stringify(options.serverAddress)}`]
      : []),
    "datastore:",
    ...(options.bucket !== undefined
      ? [`  type: ${JSON.stringify(options.bucket.typeName)}`, "  config: {}"]
      : ["  type: filesystem", `  path: ${JSON.stringify(storagePath)}`]),
    "  format: 3",
    ...(options.managedConfig ? ["  managedConfig: true"] : []),
  ];
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + lines.join("\n") + "\n",
  );
}

/**
 * Ends a command as the CLI's teardown does: flushes, closes every v3
 * handle this thread opened and releases its leases, and forgets the
 * serve-upstream bindings, as a new process starts without them.
 */
export async function endCommand(): Promise<void> {
  try {
    await flushDatastoreSync();
  } finally {
    try {
      await closeV3Datastores();
    } finally {
      resetServeUpstreamBindingsForTesting();
      // One process stands for many commands here: each warns afresh.
      resetStaleReadWarningForTesting();
    }
  }
}

/**
 * Runs `fn` against a fresh temp dir, removing it, stopping every serve and
 * closing every client when it ends.
 */
export async function withScratch(
  fn: (scratch: Scratch) => Promise<void>,
): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-serve-upstream-" }),
  );
  const configDir = join(dir, "config");
  await Deno.mkdir(configDir);
  const serves: Serve[] = [];
  const buckets: UnreachableBucket[] = [];
  let stops: PromiseSettledResult<void>[] = [];
  try {
    await fn({
      dir,
      configDir,
      async serve(options = {}) {
        const serve = await startServe(options);
        serves.push(serve);
        return serve;
      },
      bucket() {
        const bucket = registerUnreachableBucket();
        buckets.push(bucket);
        return bucket;
      },
      async client(name, options = {}) {
        const repoDir = join(dir, name);
        const storagePath = join(dir, `storage-${name}`);
        if (options.solo) await initializeV3Datastore(storagePath, "test");
        await initClient(repoDir, storagePath, options);
        return { repoDir, storagePath };
      },
    });
  } finally {
    await endCommand().catch(() => {});
    resetServeUpstreamCommandPath();
    setV3DatastoreFaultsForTesting(undefined);
    stops = await Promise.allSettled(serves.map((s) => s.stop()));
    for (const bucket of buckets) bucket.dispose();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
  // A serve that failed fails the test once everything is cleaned up.
  for (const stop of stops) {
    if (stop.status === "rejected") throw stop.reason;
  }
}

/**
 * Runs `fn` as a command at `commandPath` with `env` (see {@link serveEnv})
 * over an environment with every swamp target variable unset.
 */
export async function withClientEnv<T>(
  scratch: Pick<Scratch, "configDir">,
  env: Record<string, string | undefined>,
  commandPath: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  setServeUpstreamCommandPath(commandPath);
  try {
    return await withMockedEnv(
      { ...UNSET_ENV, SWAMP_CONFIG_DIR: scratch.configDir, ...env },
      fn,
    );
  } finally {
    resetServeUpstreamCommandPath();
  }
}

/** The environment that points a client at `serve` with `token`. */
export function serveEnv(
  serve: Pick<Serve, "origin">,
  token: string | undefined,
): Record<string, string | undefined> {
  return {
    SWAMP_SERVE_URL: serve.origin,
    SWAMP_SERVER_URL: serve.origin,
    SWAMP_SERVER_TOKEN: token,
  };
}

/**
 * One writing command in `client`: opened as a write command opens it
 * (`requireInitializedRepo`), `fn` run in its root unit, then torn down.
 */
export async function writeCommand<T>(
  scratch: Pick<Scratch, "configDir">,
  client: Pick<Client, "repoDir">,
  env: Record<string, string | undefined>,
  fn: (repos: RepositoryContext) => Promise<T>,
): Promise<T> {
  return await withClientEnv(scratch, env, ["model", "method"], async () => {
    try {
      const ctx = await requireInitializedRepo({
        repoDir: client.repoDir,
        outputMode: "json",
      });
      return await runInRootUnitOfWork(
        ctx.repoContext,
        { flush: undefined },
        () => fn(ctx.repoContext),
      );
    } finally {
      await endCommand();
    }
  });
}

/**
 * {@link writeCommand} without its teardown: for another client's command
 * that lands while one command is still open in this thread. The open
 * command's teardown ({@link endCommand}) closes both.
 */
export async function writeInOpenCommand<T>(
  scratch: Pick<Scratch, "configDir">,
  client: Pick<Client, "repoDir">,
  env: Record<string, string | undefined>,
  fn: (repos: RepositoryContext) => Promise<T>,
): Promise<T> {
  return await withClientEnv(scratch, env, ["model", "method"], async () => {
    const ctx = await requireInitializedRepo({
      repoDir: client.repoDir,
      outputMode: "json",
    });
    return await runInRootUnitOfWork(
      ctx.repoContext,
      { flush: undefined },
      () => fn(ctx.repoContext),
    );
  });
}

/**
 * One reading command in `client`: opened as a read-only command opens it
 * (`requireInitializedRepoReadOnly`), then torn down.
 */
export async function readCommand<T>(
  scratch: Pick<Scratch, "configDir">,
  client: Pick<Client, "repoDir">,
  env: Record<string, string | undefined>,
  fn: (repos: RepositoryContext) => Promise<T>,
): Promise<T> {
  return await withClientEnv(scratch, env, ["data", "get"], async () => {
    try {
      const ctx = await requireInitializedRepoReadOnly({
        repoDir: client.repoDir,
        outputMode: "json",
      });
      return await fn(ctx.repoContext);
    } finally {
      await endCommand();
    }
  });
}

/** A fixed instant, so two runs of one script write the same metadata. */
const CREATED_AT = new Date("2026-10-27T00:00:00.000Z");

/** A data version's metadata, as a manual save writes it. */
export function dataOf(name: string, id?: string): Data {
  return Data.create({
    name,
    ...(id !== undefined ? { id } : {}),
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    createdAt: CREATED_AT,
  });
}

/** JSON bytes of `value`. */
export function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** The latest version of `name` and its content, or null when there is none. */
export async function latestOf(
  repos: RepositoryContext,
  type: ModelType,
  modelId: string,
  name: string,
): Promise<{ version: number; content: string } | null> {
  const data = await repos.unifiedDataRepo.findByName(type, modelId, name);
  if (data === null) return null;
  const content = await repos.unifiedDataRepo.getContent(
    type,
    modelId,
    name,
    data.version,
  );
  return {
    version: data.version,
    content: content === null ? "<none>" : new TextDecoder().decode(content),
  };
}

/** A request a {@link Proxy} received. */
export interface ProxiedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

/** A port-0 server in front of serve that records and may rewrite. */
export interface Proxy {
  readonly origin: string;
  readonly requests: ProxiedRequest[];
  close(): Promise<void>;
}

/**
 * Starts a {@link Proxy} that forwards every request to `target` (when
 * given) unless `answer` answers it first; without a target, unanswered
 * requests get a 401, as a serve that demands a token answers. A function
 * target is asked on every request: the address can move to another serve.
 */
export function startProxy(
  target: string | undefined | (() => string | undefined),
  answer: (
    request: Request,
    forward: () => Promise<Response>,
  ) => Promise<Response | undefined> = () => Promise.resolve(undefined),
): Proxy {
  const requests: ProxiedRequest[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
      });
      const body = request.body === null
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
      const forward = async () => {
        const origin = typeof target === "function" ? target() : target;
        if (origin === undefined) {
          return Response.json({ code: "unauthorized", message: "no token" }, {
            status: 401,
          });
        }
        const headers = new Headers(request.headers);
        headers.delete("host");
        const response = await fetch(`${origin}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          ...(body !== undefined
            ? { body: body as Uint8Array<ArrayBuffer> }
            : {}),
        });
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers: response.headers,
        });
      };
      return await answer(request, forward) ?? await forward();
    },
  );
  return {
    origin: `http://127.0.0.1:${server.addr.port}`,
    requests,
    close: () => server.shutdown(),
  };
}
