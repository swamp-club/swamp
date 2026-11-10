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

// pause blocks the thread like a SIGSTOP; the Litestream sidecar keeps running

import "../src/domain/models/models.ts";
import { join } from "@std/path";
import { z } from "zod";
import { waitFor } from "@swamp-club/swamp-testing";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import {
  createModelLock,
  createWorkflowRunLock,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { LOCK_TIMEOUT_ENV_VAR } from "../src/domain/datastore/datastore_config.ts";
import { materializeAdmins } from "../src/domain/access/admin_materializer.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { PartitionKey } from "../src/domain/datastore_v3/partition_key.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  closeV3Datastores,
  confirmV3Replicated,
  enableV3ServeTeamMode,
  holdV3Writer,
  refreshV3FollowerCopy,
  startV3ReplicationUpkeep,
  v3CommitFeedSource,
  v3CommitMark,
  type V3DatastoreConfig,
  v3DatastoreConfigOf,
  v3DatastoreFor,
  type V3ReplicationUpkeep,
  v3ServeControlPlaneAt,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  acquireV3WriterLock,
  holdsCurrentV3WriterLease,
  v3WriterFence,
  v3WriterLeaseConfirmed,
  v3WriterLeaseHolder,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { UploadLedger } from "../src/infrastructure/datastore_v3/upload_ledger.ts";
import {
  handleDatastoreRequest,
  setCommitStageBarrierForTesting,
} from "../src/serve/datastore_api.ts";
import { matchDatastoreRoute } from "../src/serve/datastore_routes.ts";
import {
  asTryLock,
  DatastoreLockLeases,
} from "../src/serve/datastore_locks.ts";
import { handleMessage } from "../src/serve/connection.ts";
import {
  type FollowerPolicyWiring,
  wireFollowerPolicy,
} from "../src/serve/follower_policy_wiring.ts";
import {
  createGrantWriteCommit,
  createGrantWriteTracking,
} from "../src/serve/grant_write_tracking.ts";
import { ServeLeadership } from "../src/serve/serve_leadership.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { TEST_TIMINGS } from "./datastore_v3_litestream_helpers.ts";
import { createServeCtx, type Frame } from "./serve_request_harness.ts";

export type FencedNodeRequest =
  | {
    readonly kind: "init";
    readonly hostname: string;
    readonly replica: string;
    readonly privateRoot: string;
    readonly datastorePath: string;
    readonly repoDir: string;
    readonly modelType: string;
    readonly tokens: Readonly<Record<string, string>>;
  }
  /** ttlMs: this node's writer lease, taken before serve's own hold joins it */
  | { readonly kind: "open"; readonly ttlMs?: number }
  | { readonly kind: "saveModel"; readonly name: string }
  | { readonly kind: "materialize"; readonly admins: readonly string[] }
  | { readonly kind: "confirm" }
  | { readonly kind: "tick" }
  | { readonly kind: "state" }
  /** the next commit to reach `stage` waits there until released */
  | { readonly kind: "hold"; readonly stage: string }
  | { readonly kind: "held"; readonly stage: string }
  | { readonly kind: "release"; readonly stage: string }
  /** release: let a held commit go on in the same turn the thread resumes */
  | { readonly kind: "pause"; readonly ms: number; readonly release?: string }
  | {
    readonly kind: "partitionAt";
    readonly partition: string;
    readonly seq: number;
  }
  | { readonly kind: "feedHead"; readonly principal: string }
  | {
    readonly kind: "feedSubscribe";
    readonly principal: string;
    readonly cursor: number;
  }
  | { readonly kind: "pids" }
  | { readonly kind: "close" };

export type FencedNodeResponse =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: string };

export interface Opened {
  readonly role: "writer" | "follower";
  readonly origin: string;
}

export interface FencedNodeState {
  readonly role: "leader" | "follower";
  readonly leadUnconfirmed: boolean;
  readonly holdsCurrentLease: boolean;
  readonly fence?: number;
  /** the highest fence the shared lease records, whoever holds it */
  readonly currentFence?: number;
  readonly events: readonly string[];
  readonly head: number;
  readonly feedBound: number;
}

export interface StoredCommit {
  readonly seq: number;
  readonly txnId: string;
  readonly namespace: string;
  readonly fence?: number;
  readonly principal?: string;
}

declare const self: Worker;

const OWNER_ADDRESS = "http://leader.example:9090";

let init: Extract<FencedNodeRequest, { kind: "init" }> | undefined;
let repoContext: RepositoryContext | undefined;
let location: V3DatastoreConfig | undefined;
let modelType: ModelType | undefined;
let loader: PolicySnapshotLoader | undefined;
let ctx: ConnectionContext | undefined;
let wiring: FollowerPolicyWiring | undefined;
let upkeep: V3ReplicationUpkeep | undefined;
let locks: DatastoreLockLeases | undefined;
let http: Deno.HttpServer | undefined;
let leadership: ServeLeadership | undefined;
let shortLease: (() => Promise<void>) | undefined;
const events: string[] = [];
const launched = new Set<number>();

interface Hold {
  arrived: boolean;
  readonly gate: PromiseWithResolvers<void>;
}
const holds = new Map<string, Hold>();

setCommitStageBarrierForTesting(async (stage) => {
  const hold = holds.get(stage);
  if (hold === undefined || hold.arrived) return;
  hold.arrived = true;
  await hold.gate.promise;
});

function setEnvironment(
  overrides: Record<string, string | undefined>,
): void {
  // realm-wide: lease renewals and the sidecar read it after a request returns
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
    value: (key: string) =>
      Object.hasOwn(overrides, key)
        ? overrides[key] !== undefined
        : realHas(key),
  });
  Object.defineProperty(Deno.env, "toObject", {
    configurable: true,
    value: () => {
      const merged: Record<string, string> = { ...realToObject() };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      return merged;
    },
  });
}

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

async function open(ttlMs: number | undefined): Promise<Opened> {
  const request = init!;
  await initCheckout(request.repoDir, request.datastorePath);
  if (ttlMs !== undefined) {
    shortLease = await acquireV3WriterLock(request.datastorePath, {
      ttlMs,
      retakeLost: true,
    });
  }
  const opened = await requireInitializedRepoUnlocked({
    repoDir: request.repoDir,
    outputMode: "json",
    retakeLostV3Lease: true,
    followV3Lease: true,
    v3OwnerCheck: { as: "serve", address: OWNER_ADDRESS },
  });
  repoContext = opened.repoContext;
  const role = opened.v3Role!;
  const here = await v3DatastoreConfigOf(
    opened.repoDir,
    opened.datastoreConfig,
  );
  location = here;
  const repoDir = opened.repoDir;
  if (role === "writer") upkeep = startV3ReplicationUpkeep(repoDir, here);
  loader = new PolicySnapshotLoader(
    opened.repoContext.unifiedDataRepo,
    opened.repoContext.eventBus,
    "manual",
    { runImpliesApprove: true, runImpliesSignal: true, writeImpliesTag: true },
  );
  await loader.load();
  const base = createServeCtx({
    repoDir,
    repoContext: opened.repoContext,
    datastoreConfig: opened.datastoreConfig,
    datastoreResolver: opened
      .datastoreResolver as ConnectionContext["datastoreResolver"],
    modelType: modelType!,
  }, []);
  // as serve.ts wires a replicating v3 datastore
  const node = {
    ...base,
    policySnapshotLoader: loader,
    confirmReplicated: () => confirmV3Replicated(here.path),
    replicationMark: () => v3CommitMark(here.path),
    holdRepliesUntilCommitted: true,
  } as ConnectionContext;
  ctx = node;
  const policyLoader = loader;
  wiring = wireFollowerPolicy({
    source: v3CommitFeedSource(repoDir, here),
    reloadPolicy: () => policyLoader.load(),
    checkConfig: () => {},
    isFollower: () => node.followerGate?.role === "follower",
  });
  node.commitFeed = wiring.commitFeed;
  const effects = wiring.effects;
  effects.start();
  const lead = new ServeLeadership({
    instanceId: `instance-${request.hostname}`,
    address: `http://${request.hostname}:9090`,
    lease: {
      holdsCurrent: () => holdsCurrentV3WriterLease(here.path),
      confirmed: () => v3WriterLeaseConfirmed(here.path),
      fence: () => v3WriterFence(here.path),
      currentFence: async () => (await v3WriterLeaseHolder(here.path))?.fence,
      take: () =>
        holdV3Writer(here, repoDir, {
          retakeLost: true,
          follow: true,
          ownerCheck: { as: "serve", address: OWNER_ADDRESS },
        }),
    },
    store: v3ServeControlPlaneAt(here),
    refreshCopy: async () => {
      await refreshV3FollowerCopy(repoDir, here);
      effects.poke();
    },
    onLead: async () => {
      events.push("lead");
      if (role === "writer") return;
      await node.commitFeed?.datastore.catchUp();
      effects.poke();
      await effects.settled();
      upkeep ??= startV3ReplicationUpkeep(repoDir, here);
    },
    // serve shuts down here; kept answering to show what the shutdown window serves
    onLostLead: () => {
      events.push("lost");
      return Promise.resolve();
    },
    tickMs: 3_600_000,
  });
  leadership = lead;
  node.followerGate = wiring.gate(lead);
  enableV3ServeTeamMode(here.path, () => lead.leader());
  await lead.start(role);
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
        v3: v3DatastoreFor(repoDir, here),
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

function principalOf(principal: string): { kind: "user"; id: string } {
  const [, id] = principal.split(":");
  return { kind: "user", id };
}

/** the frames a commits.subscribe sends before its first page or refusal */
async function subscribeOnce(
  principal: string,
  cursor: number,
): Promise<Frame[]> {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
  const active = new Map<string, AbortController>();
  const id = crypto.randomUUID();
  const task = handleMessage(
    socket,
    ctx!,
    active,
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "commits.subscribe",
        id,
        payload: { cursor },
      }),
    }),
    principalOf(principal),
  );
  await waitFor(
    () => sent.length > 0 || !active.has(id),
    "the feed's first frame",
    { timeoutMs: 30_000 },
  );
  active.get(id)?.abort();
  await task;
  await waitFor(() => !active.has(id), "the subscription to end");
  return sent.map((raw) => JSON.parse(raw) as Frame);
}

async function feedHead(principal: string): Promise<Frame[]> {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    close() {},
  } as unknown as WebSocket;
  const active = new Map<string, AbortController>();
  const id = crypto.randomUUID();
  await handleMessage(
    socket,
    ctx!,
    active,
    new MessageEvent("message", {
      data: JSON.stringify({ type: "commits.head", id }),
    }),
    principalOf(principal),
  );
  await waitFor(() => !active.has(id), "commits.head to finish");
  return sent.map((raw) => JSON.parse(raw) as Frame);
}

async function handle(request: FencedNodeRequest): Promise<unknown> {
  switch (request.kind) {
    case "init": {
      init = request;
      await initializeLogging({});
      setEnvironment({
        [V3_REPLICA_ENV]: request.replica,
        [LOCK_TIMEOUT_ENV_VAR]: "30000",
      });
      // only the writer lease sees this name: the sidecar's check needs the real host
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
      return await open(request.ttlMs);
    case "saveModel": {
      const definition = Definition.create({
        name: request.name,
        globalArguments: {},
      });
      await inRoot(() =>
        repoContext!.definitionRepo.save(modelType!, definition)
      );
      return definition.id;
    }
    case "materialize":
      return await materialize(request.admins);
    case "confirm":
      await confirmV3Replicated(init!.datastorePath);
      return undefined;
    case "tick":
      await leadership!.tick();
      return undefined;
    case "state": {
      const path = init!.datastorePath;
      const fence = v3WriterFence(path);
      const currentFence = (await v3WriterLeaseHolder(path))?.fence;
      return {
        role: leadership!.role,
        leadUnconfirmed: leadership!.leadUnconfirmed(),
        holdsCurrentLease: holdsCurrentV3WriterLease(path),
        ...(fence !== undefined ? { fence } : {}),
        ...(currentFence !== undefined ? { currentFence } : {}),
        events: [...events],
        head: v3DatastoreFor(init!.repoDir, location!).commitStore
          .highWaterMark().cursor,
        feedBound: wiring!.commitFeed.bound(),
      } satisfies FencedNodeState;
    }
    case "hold":
      holds.set(request.stage, {
        arrived: false,
        gate: Promise.withResolvers<void>(),
      });
      return undefined;
    case "held":
      return holds.get(request.stage)?.arrived === true;
    case "release":
      holds.get(request.stage)?.gate.resolve();
      return undefined;
    case "pause":
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.ms);
      if (request.release !== undefined) {
        holds.get(request.release)?.gate.resolve();
      }
      return undefined;
    case "partitionAt": {
      const v3 = v3DatastoreFor(init!.repoDir, location!);
      const partition = PartitionKey.parse(request.partition);
      const [change] = await v3.commitStore.readPartition(
        v3.namespace,
        partition,
        request.seq,
        1,
      );
      const head = (await v3.commitStore.head(v3.namespace, partition)).seq;
      const commit = change?.commit;
      return {
        head,
        commit: commit === undefined || commit.seq !== request.seq
          ? undefined
          : {
            seq: commit.seq,
            txnId: commit.txnId,
            namespace: commit.namespace,
            ...(commit.fence !== undefined ? { fence: commit.fence } : {}),
            ...(commit.principal !== undefined
              ? { principal: commit.principal }
              : {}),
          } satisfies StoredCommit,
      };
    }
    case "feedHead":
      return await feedHead(request.principal);
    case "feedSubscribe":
      return await subscribeOnce(request.principal, request.cursor);
    case "pids":
      return [...launched];
    case "close":
      for (const hold of holds.values()) hold.gate.resolve();
      try {
        await leadership?.stop();
        await wiring?.effects.stop();
        await http?.shutdown();
        await locks?.dispose();
        await upkeep?.stop();
        await loader?.dispose();
      } finally {
        await closeV3Datastores();
        await shortLease?.().catch(() => {});
      }
      return undefined;
  }
}

self.onmessage = async (event: MessageEvent<FencedNodeRequest>) => {
  try {
    self.postMessage(
      {
        ok: true,
        value: await handle(event.data),
      } satisfies FencedNodeResponse,
    );
  } catch (error) {
    self.postMessage(
      {
        ok: false,
        error: error instanceof Error
          ? error.stack ?? error.message
          : String(error),
      } satisfies FencedNodeResponse,
    );
  }
};
