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

// One serve node for serve_v3_team_bucket_policy_test.ts (swamp-club#4207):
// a Worker with its own module state, so its writer lease, its v3 handles and
// the serve team it follows are its own, and its own host name as its writer
// lease sees it, so the other node's lease is a remote holder's. Each node
// has its own checkout of one filesystem-v3 datastore that replicates to a
// file replica through a real Litestream, as a bucket's does: the follower
// restores its own copy and takes the leader's commits through
// `applyV3LeaderChanges`, as serve's follower feed applies them. Each node
// answers the datastore API on a port-0 server over its own repository,
// with a real access policy loaded from its own read model.

import "../src/domain/models/models.ts";
import { join } from "@std/path";
import { z } from "zod";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  createModelLock,
  createWorkflowRunLock,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { LOCK_TIMEOUT_ENV_VAR } from "../src/domain/datastore/datastore_config.ts";
import { materializeAdmins } from "../src/domain/access/admin_materializer.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  applyV3LeaderChanges,
  type LeaderChange,
} from "../src/infrastructure/datastore_v3/serve_feed.ts";
import {
  closeV3Datastores,
  confirmV3Replicated,
  startV3ReplicationUpkeep,
  v3CommitFeedSource,
  type V3DatastoreConfig,
  v3DatastoreConfigOf,
  v3DatastoreFor,
  type V3ReplicationUpkeep,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import { handleDatastoreRequest } from "../src/serve/datastore_api.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import {
  asTryLock,
  DatastoreLockLeases,
} from "../src/serve/datastore_locks.ts";
import type { FollowerGate } from "../src/serve/follower_requests.ts";
import {
  type FollowerPolicyWiring,
  wireFollowerPolicy,
} from "../src/serve/follower_policy_wiring.ts";
import {
  createGrantWriteCommit,
  createGrantWriteTracking,
} from "../src/serve/grant_write_tracking.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { TEST_TIMINGS } from "./datastore_v3_litestream_helpers.ts";
import {
  createServeCtx,
  type Frame,
  sendRequest,
} from "./serve_request_harness.ts";

/** What the test asks a node to do. */
export type NodeRequest =
  | {
    readonly kind: "init";
    readonly hostname: string;
    readonly replica: string;
    readonly privateRoot: string;
    readonly datastorePath: string;
    readonly repoDir: string;
    /** The behavior type every node and the test's client register. */
    readonly modelType: string;
    /** Bearer tokens the node's datastore API accepts, and whom they name. */
    readonly tokens: Readonly<Record<string, string>>;
  }
  /**
   * Opens the checkout as serve opens it: the writer lease when free, else
   * following, with the follower's copy restored from the replica. Starts
   * the datastore API and loads the access policy from the read model.
   */
  | { readonly kind: "open" }
  /**
   * Saves a behavior definition `name` of the test's type, with `id` when
   * given: the repository's file, as the node's clone of it holds it.
   */
  | { readonly kind: "saveModel"; readonly name: string; readonly id?: string }
  /** `count` saves of data `dataName` on behavior `modelId`. */
  | {
    readonly kind: "saveData";
    readonly modelId: string;
    readonly dataName: string;
    readonly count: number;
  }
  /**
   * Serve's grant config at boot or lead: `--admins` materialized as admin
   * grant records, committed, then the node's policy reloaded.
   */
  | { readonly kind: "materialize"; readonly admins: readonly string[] }
  /** Serve's write confirmation: the published head covers every commit. */
  | { readonly kind: "confirm" }
  /** The node's commits after `cursor`, as the leader's feed sends them. */
  | { readonly kind: "changesSince"; readonly cursor: number }
  /** The last cursor this node's copy holds. */
  | { readonly kind: "head" }
  /**
   * The follower feed's step: the leader's changes applied, the effects
   * poked as `onFresh` does, and their pass settled.
   */
  | { readonly kind: "apply"; readonly changes: readonly LeaderChange[] }
  /** Active grants the node's loaded policy holds for `subject`. */
  | { readonly kind: "grants"; readonly subject: string }
  /** Serve's `data.list` request for `modelName`, as `principal` sends it. */
  | {
    readonly kind: "dataList";
    readonly principal: string;
    readonly modelName: string;
  }
  /** Makes the follower's policy reloads fail, or succeed again. */
  | { readonly kind: "failReloads"; readonly fail: boolean }
  /** What the follower feed's `onFresh` does: pokes the effects. */
  | { readonly kind: "poke" }
  /** The follower's view of its own feed. */
  | { readonly kind: "feed" }
  | { readonly kind: "pids" }
  | { readonly kind: "close" };

/** A node's answer. */
export type NodeResponse =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: string };

/** What `open` answers. */
export interface Opened {
  readonly role: "writer" | "follower";
  /** The datastore API's origin. */
  readonly origin: string;
}

/** What `feed` answers. */
export interface FeedState {
  /** The last cursor the follower's copy holds. */
  readonly head: number;
  /** The last cursor serve's reads may page to. */
  readonly bound: number;
  readonly policyKnown: boolean;
}

declare const self: Worker;

/** The leader a follower's refusals name. */
const LEADER = {
  instanceId: "instance-leader",
  fence: 1,
  address: "http://leader.example:9090",
  since: "2026-10-30T00:00:00.000Z",
};

let init: Extract<NodeRequest, { kind: "init" }> | undefined;
let repoContext: RepositoryContext | undefined;
let location: V3DatastoreConfig | undefined;
let modelType: ModelType | undefined;
let loader: PolicySnapshotLoader | undefined;
let ctx: ConnectionContext | undefined;
let wiring: FollowerPolicyWiring | undefined;
let upkeep: V3ReplicationUpkeep | undefined;
let locks: DatastoreLockLeases | undefined;
let http: Deno.HttpServer | undefined;
let failReloads = false;
const launched = new Set<number>();

/**
 * This node's environment, for the worker's whole life: its lease renewals
 * and Litestream sidecar run after any one request has returned, so a
 * scoped mock cannot cover them. Realm-local.
 */
function setEnvironment(overrides: Record<string, string>): void {
  const realGet = Deno.env.get.bind(Deno.env);
  const realHas = Deno.env.has.bind(Deno.env);
  const realToObject = Deno.env.toObject.bind(Deno.env);
  Object.defineProperty(Deno.env, "get", {
    configurable: true,
    value: (key: string) =>
      Object.hasOwn(overrides, key) ? overrides[key] : realGet(key),
  });
  Object.defineProperty(Deno.env, "has", {
    configurable: true,
    value: (key: string) => Object.hasOwn(overrides, key) || realHas(key),
  });
  Object.defineProperty(Deno.env, "toObject", {
    configurable: true,
    value: () => ({ ...realToObject(), ...overrides }),
  });
}

/** A checkout whose datastore is the shared filesystem-v3 datastore. */
async function initCheckout(
  repoDir: string,
  datastorePath: string,
): Promise<void> {
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(repoDir, "test-home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const markerPath = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(markerPath);
  await Deno.writeTextFile(
    markerPath,
    marker.trimEnd() + "\n" + [
      "datastore:",
      "  type: filesystem",
      `  path: ${JSON.stringify(datastorePath)}`,
      "  format: 3",
    ].join("\n") + "\n",
  );
}

async function open(): Promise<Opened> {
  const request = init!;
  await initCheckout(request.repoDir, request.datastorePath);
  const opened = await requireInitializedRepoUnlocked({
    repoDir: request.repoDir,
    outputMode: "json",
    // As serve opens it (serve.ts): retakes a lost lease, follows a lease
    // another serve holds.
    retakeLostV3Lease: true,
    followV3Lease: true,
    v3OwnerCheck: { as: "serve", address: LEADER.address },
  });
  repoContext = opened.repoContext;
  const role = opened.v3Role!;
  location = await v3DatastoreConfigOf(opened.repoDir, opened.datastoreConfig);
  if (role === "writer") {
    upkeep = startV3ReplicationUpkeep(opened.repoDir, location);
  }
  loader = new PolicySnapshotLoader(
    opened.repoContext.unifiedDataRepo,
    opened.repoContext.eventBus,
    "manual",
    { runImpliesApprove: true, runImpliesSignal: true, writeImpliesTag: true },
  );
  await loader.load();
  const base = createServeCtx({
    repoDir: opened.repoDir,
    repoContext: opened.repoContext,
    datastoreConfig: opened.datastoreConfig,
    datastoreResolver: opened
      .datastoreResolver as ConnectionContext["datastoreResolver"],
    modelType: modelType!,
  }, []);
  const node = { ...base, policySnapshotLoader: loader } as ConnectionContext;
  ctx = node;
  if (role === "follower") {
    // Serve's follower wiring (serve.ts): the real composition, with the
    // reload able to fail on request.
    const source = v3CommitFeedSource(opened.repoDir, location);
    const policyLoader = loader;
    wiring = wireFollowerPolicy({
      source,
      catchUpReadModel: () => source.datastore.catchUp(),
      catalogInvalidate: () => opened.repoContext.catalogStore.invalidate(),
      reloadPolicy: () =>
        failReloads
          ? Promise.reject(new Error("the policy reload failed"))
          : policyLoader.load(),
      checkConfig: () => {},
      isFollower: () => node.followerGate?.role === "follower",
    });
    node.commitFeed = wiring.commitFeed;
    wiring.effects.start();
    const leadership: FollowerGate = {
      role: "follower",
      leader: () => LEADER,
      isStale: () => false,
    };
    node.followerGate = wiring.gate(leadership);
  }
  const v3 = v3DatastoreFor(opened.repoDir, location);
  const datastoreConfig = opened.datastoreConfig;
  locks = new DatastoreLockLeases({
    createLock: async (target) =>
      asTryLock(
        target.kind === "model"
          ? await createModelLock(
            datastoreConfig,
            target.modelType,
            target.modelId,
          )
          : await createWorkflowRunLock(datastoreConfig, target.runId),
      ),
  });
  const leases = locks;
  const ledger = new UploadLedger();
  const tokens = request.tokens;
  http = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const route = matchDatastoreRoute(new URL(req.url).pathname);
      if (route === undefined) return new Response("no", { status: 404 });
      return await handleDatastoreRequest(req, route, "127.0.0.1", {
        ctx: node,
        v3,
        ledger,
        locks: leases,
        authenticate: (token) => {
          const principalId = tokens[token];
          return Promise.resolve(
            principalId === undefined
              ? { ok: false, error: "bad token", reason: "secret-mismatch" }
              : {
                ok: true,
                principalId,
                collectives: [],
                groups: [],
                tokenName: token,
                tokenCreatedAt: "2026-01-01T00:00:00Z",
              },
          );
        },
      });
    },
  );
  return {
    role,
    origin: `http://127.0.0.1:${(http.addr as Deno.NetAddr).port}`,
  };
}

function inRoot<T>(fn: () => Promise<T>): Promise<T> {
  return runInRootUnitOfWork(repoContext!, { flush: undefined }, fn);
}

async function materialize(admins: readonly string[]): Promise<unknown> {
  const repos = repoContext!;
  // As serve builds its grant stores (serve.ts): definitions read from the
  // repository, written to its auto-definitions.
  const autoDefRepo = new YamlDefinitionRepository(
    init!.repoDir,
    undefined,
    repos.autoDefinitionsDir,
    false,
    repos.markDirty,
  );
  const grantWrites = createGrantWriteTracking(
    repos.definitionRepo,
    autoDefRepo,
    repos.unifiedDataRepo,
  );
  const commitGrantWrites = createGrantWriteCommit(undefined, grantWrites, {
    markDirty: repos.markDirty,
  });
  const result = await commitGrantWrites(() =>
    materializeAdmins("token", [...admins], grantWrites.adminGrantStore)
  );
  await loader!.load();
  return result;
}

async function handle(request: NodeRequest): Promise<unknown> {
  switch (request.kind) {
    case "init": {
      init = request;
      await initializeLogging({});
      setEnvironment({
        [V3_REPLICA_ENV]: request.replica,
        [LOCK_TIMEOUT_ENV_VAR]: "30000",
      });
      // Only the writer lease sees this node's name: the other node's lease
      // is then a remote holder's. The sidecar's supervisor is a real
      // process on this host, which its checks must still recognise.
      const hostname = request.hostname;
      const realHostname = Deno.hostname.bind(Deno);
      Object.defineProperty(Deno, "hostname", {
        configurable: true,
        value: () =>
          /v3_writer_lock\.ts|writer_lease\.ts/.test(new Error().stack ?? "")
            ? hostname
            : realHostname(),
      });
      setV3ReplicationForTesting({
        processes: {
          ...hostLitestreamProcesses,
          launch: (launch) => {
            const pid = hostLitestreamProcesses.launch(launch);
            launched.add(pid);
            return pid;
          },
        },
        privateRoot: request.privateRoot,
        timings: TEST_TIMINGS,
      });
      modelType = ModelType.create(request.modelType);
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
      return undefined;
    }
    case "open":
      return await open();
    case "saveModel": {
      const definition = Definition.create({
        ...(request.id !== undefined ? { id: request.id } : {}),
        name: request.name,
        globalArguments: {},
      });
      await inRoot(() =>
        repoContext!.definitionRepo.save(modelType!, definition)
      );
      return definition.id;
    }
    case "saveData": {
      const versions: number[] = [];
      for (let i = 0; i < request.count; i++) {
        const saved = await inRoot(() =>
          repoContext!.unifiedDataRepo.save(
            modelType!,
            request.modelId,
            Data.create({
              name: request.dataName,
              contentType: "application/json",
              lifetime: "infinite",
              garbageCollection: 10,
              tags: { type: "resource" },
              ownerDefinition: { ownerType: "manual", ownerRef: "test" },
            }),
            new TextEncoder().encode(JSON.stringify({ i })),
          )
        );
        versions.push(saved.version);
      }
      return versions;
    }
    case "materialize":
      return await materialize(request.admins);
    case "confirm":
      await confirmV3Replicated(init!.datastorePath);
      return undefined;
    case "changesSince": {
      const store = v3DatastoreFor(init!.repoDir, location!).commitStore;
      const changes = await store.changesSince(request.cursor, 100_000);
      return changes.map(({ cursor, commit }) => ({
        cursor,
        commit: commit.toJSON(),
      })) satisfies LeaderChange[];
    }
    case "head":
      return v3DatastoreFor(init!.repoDir, location!).commitStore
        .highWaterMark().cursor;
    case "apply":
      await applyV3LeaderChanges(init!.repoDir, location!, request.changes);
      wiring!.effects.poke();
      await wiring!.effects.settled();
      return undefined;
    case "grants":
      return loader!.snapshot.grantsForSubjects([request.subject]).filter((
        grant,
      ) => grant.state === "active").length;
    case "dataList": {
      const [kind, id] = request.principal.split(":");
      const frames: Frame[] = await sendRequest(ctx!, {
        type: "data.list",
        id: crypto.randomUUID(),
        payload: { modelIdOrName: request.modelName },
      }, { kind: kind as "user", id });
      return frames;
    }
    case "failReloads":
      failReloads = request.fail;
      return undefined;
    case "poke":
      wiring!.effects.poke();
      await wiring!.effects.settled();
      return undefined;
    case "feed":
      return {
        head: v3DatastoreFor(init!.repoDir, location!).commitStore
          .highWaterMark().cursor,
        bound: wiring!.commitFeed.bound(),
        policyKnown: wiring!.gate({
          role: "follower",
          leader: () => LEADER,
          isStale: () => false,
        }).isStale() === false,
      } satisfies FeedState;
    case "pids":
      return [...launched];
    case "close":
      try {
        await wiring?.effects.stop();
        await http?.shutdown();
        await locks?.dispose();
        await upkeep?.stop();
        await loader?.dispose();
      } finally {
        await closeV3Datastores();
      }
      return undefined;
  }
}

self.onmessage = async (event: MessageEvent<NodeRequest>) => {
  try {
    self.postMessage(
      { ok: true, value: await handle(event.data) } satisfies NodeResponse,
    );
  } catch (error) {
    self.postMessage(
      {
        ok: false,
        error: error instanceof Error
          ? error.stack ?? error.message
          : String(error),
      } satisfies NodeResponse,
    );
  }
};
