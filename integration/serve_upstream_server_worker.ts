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

// serve's datastore API test server in its own Worker, so client checkouts in
// the main thread can end their commands without closing serve's handle or
// releasing its writer lease

import "../src/domain/models/models.ts";
import { z } from "zod";
import { acquireModelLocks } from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DatastoreOwner } from "../src/domain/datastore_v3/datastore_owner.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { withServer } from "./serve_datastore_api_harness.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { grant } from "./serve_request_harness.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { DatastoreLockLeases } from "../src/serve/datastore_locks.ts";
import { setOwnLockGate } from "../src/infrastructure/datastore_v3/own_lock_gate.ts";
import { sendRequest } from "./serve_request_harness.ts";
import { setRunCheckpointIntervalForTesting } from "../src/infrastructure/persistence/workflow_run_checkpointer.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import {
  registerBarrierReport,
  type WorkflowReportBarrier,
} from "./workflow_report_barrier.ts";

export interface GrantSpec {
  readonly user?: string;
  readonly actions: readonly string[];
  readonly kind: string;
  readonly pattern: string;
}

export type ServeWorkerRequest =
  | {
    readonly kind: "start";
    readonly grants: readonly GrantSpec[];
    readonly models?: readonly string[];
    readonly managedConfig?: boolean;
    readonly commitFeed?: boolean;
    readonly checkpointIntervalMs?: number;
    /** adds a read method writing the `out` resource, as a refreshing get does */
    readonly refreshMethod?: boolean;
    /** serve opens its datastore as serve at this address, as `swamp serve` does */
    readonly servedAs?: string;
    /** and claims it under that address */
    readonly claimed?: boolean;
  }
  | { readonly kind: "log" }
  | { readonly kind: "renewals" }
  | { readonly kind: "lock-stats" }
  | {
    readonly kind: "method-run";
    readonly modelIdOrName: string;
    readonly methodName: string;
  }
  | { readonly kind: "grants"; readonly grants: readonly GrantSpec[] }
  | { readonly kind: "restrict"; readonly types: readonly string[] }
  | {
    readonly kind: "force-release";
    readonly modelType: string;
    readonly modelId: string;
  }
  | { readonly kind: "compact"; readonly claim?: boolean }
  | {
    readonly kind: "write";
    readonly dataName: string;
    readonly dataId: string;
    readonly count: number;
  }
  | {
    readonly kind: "run-workflow";
    readonly workflowName: string;
    readonly initiatedBy: string;
    readonly barrier?: WorkflowReportBarrier;
  }
  | { readonly kind: "stop" };

export interface ServeLogEntry {
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
  readonly principal: string | undefined;
  readonly keys: readonly string[];
  readonly leaseFence?: number;
}

export type ServeWorkerMessage =
  | { readonly kind: "loaded" }
  | {
    readonly kind: "ready";
    readonly origin: string;
    readonly modelType: string;
    readonly models: Readonly<Record<string, string>>;
    readonly serveRepo: string;
  }
  | { readonly kind: "log"; readonly entries: readonly ServeLogEntry[] }
  | { readonly kind: "compacted"; readonly point: number }
  | { readonly kind: "granted" }
  | { readonly kind: "restricted" }
  | { readonly kind: "force-released"; readonly principal?: string }
  | { readonly kind: "renewals"; readonly refused: number }
  | {
    readonly kind: "lock-stats";
    /** lock requests serve answered held by someone else */
    readonly busy: number;
    /** keys serve's own runs asked to lock, in order */
    readonly ownLockKeys: readonly string[];
  }
  | { readonly kind: "ran-method"; readonly errors: readonly string[] }
  | {
    readonly kind: "wrote";
    readonly versions: readonly number[];
    readonly errors: readonly string[];
  }
  | {
    readonly kind: "ran-workflow";
    readonly statuses: readonly string[];
    readonly errors: readonly string[];
  }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly error: string };

declare const self: Worker;

// Not awaited at the top level: the handler must be set before the test's
// first message arrives.
const logging = initializeLogging({});

let stop: (() => void) | undefined;
/**
 * renewals or releases of a lease serve no longer holds: serve asks whether
 * such a lease awaits adoption before it answers not found
 */
let refusedRenewals = 0;

let busyAnswers = 0;
const ownLockKeys: string[] = [];

class CountingLeases extends DatastoreLockLeases {
  override async acquire(
    ...args: Parameters<DatastoreLockLeases["acquire"]>
  ): ReturnType<DatastoreLockLeases["acquire"]> {
    const outcome = await super.acquire(...args);
    if (outcome.kind === "held") busyAnswers++;
    return outcome;
  }

  override leaseAdoptionPending(leaseId: string): boolean {
    const pending = super.leaseAdoptionPending(leaseId);
    if (!pending) refusedRenewals++;
    return pending;
  }
}
let methodRun:
  | ((
    request: Extract<ServeWorkerRequest, { kind: "method-run" }>,
  ) => Promise<void>)
  | undefined;
let forceRelease:
  | ((
    request: Extract<ServeWorkerRequest, { kind: "force-release" }>,
  ) => Promise<void>)
  | undefined;
let log: (() => Promise<void>) | undefined;
let restrict:
  | ((request: Extract<ServeWorkerRequest, { kind: "restrict" }>) => void)
  | undefined;
let setGrants:
  | ((request: Extract<ServeWorkerRequest, { kind: "grants" }>) => void)
  | undefined;
let runWorkflow:
  | ((
    request: Extract<ServeWorkerRequest, { kind: "run-workflow" }>,
  ) => Promise<void>)
  | undefined;
let compact:
  | ((
    request: Extract<ServeWorkerRequest, { kind: "compact" }>,
  ) => Promise<void>)
  | undefined;
let write:
  | ((request: Extract<ServeWorkerRequest, { kind: "write" }>) => Promise<void>)
  | undefined;

/**
 * A grant's id, from its spec: the same spec is the same grant record in
 * every snapshot, as a reload of serve's access data keeps record ids.
 */
function grantId(spec: GrantSpec): string {
  return `grant-${
    JSON.stringify([spec.user ?? "", spec.actions, spec.kind, spec.pattern])
  }`;
}

function toGrant(spec: GrantSpec): Grant {
  return grant({
    id: grantId(spec),
    ...(spec.user !== undefined
      ? { subject: { kind: "user", name: spec.user } }
      : {}),
    actions: [...spec.actions] as Grant["actions"],
    resource: { kind: spec.kind, pattern: spec.pattern } as Grant["resource"],
  });
}

async function start(
  request: Extract<ServeWorkerRequest, { kind: "start" }>,
): Promise<void> {
  await logging;
  if (request.checkpointIntervalMs !== undefined) {
    setRunCheckpointIntervalForTesting(request.checkpointIntervalMs);
  }
  setOwnLockGate((lockKey) => {
    ownLockKeys.push(lockKey);
    return Promise.resolve();
  });
  await withServer(
    request.grants.map(toGrant),
    async (server) => {
      if (request.commitFeed === true) {
        const store = server.v3.commitStore;
        (server.ctx as ConnectionContext).commitFeed = {
          datastore: server.v3,
          bound: () => store.highWaterMark().cursor,
          onMoved: (listener) => store.onHeadMoved(listener),
        };
      }
      if (request.refreshMethod === true) {
        modelRegistry.invalidateType(server.modelType);
        modelRegistry.register({
          type: server.modelType,
          version: "2026.01.01.1",
          resources: {
            out: {
              description: "One data version per run",
              schema: z.object({ body: z.string() }),
              lifetime: "infinite",
              garbageCollection: 10,
            },
          },
          methods: {
            noop: {
              description: "does nothing",
              kind: "read",
              arguments: z.object({}),
              execute: () => Promise.resolve({}),
            },
            refresh: {
              description: "a read that writes the resource it read",
              kind: "read",
              arguments: z.object({}),
              execute: async (_args, context) => ({
                dataHandles: [
                  await context.writeResource!("out", "out", { body: "r" }),
                ],
              }),
            },
          },
        });
      }
      if (request.servedAs !== undefined && request.claimed === true) {
        const store = server.v3.commitStore;
        await store.claimOwner(
          store.writerFence() ?? 1,
          DatastoreOwner.create({
            address: request.servedAs,
            claimedAt: new Date().toISOString(),
            claimedAtCursor: store.highWaterMark().cursor,
          }),
        );
      }
      const models: Record<string, string> = { web: server.model.id };
      for (const name of request.models ?? []) {
        const model = Definition.create({ name, globalArguments: {} });
        await runInRootUnitOfWork(
          server.ctx.repoContext,
          { flush: undefined },
          () =>
            server.ctx.repoContext.definitionRepo.save(server.modelType, model),
        );
        models[name] = model.id;
      }
      log = async () => {
        const changes = await server.v3.commitStore.changesSince(
          await server.v3.commitStore.compactionPoint(),
          100_000,
        );
        self.postMessage(
          {
            kind: "log",
            entries: changes.map(({ commit }) => ({
              partition: commit.partition.toString(),
              seq: commit.seq,
              txnId: commit.txnId,
              principal: commit.principal,
              keys: commit.ops.flatMap((op) =>
                "key" in op ? [op.key.toString()] : []
              ),
              ...Object.fromEntries(
                commit.ops.flatMap((op) =>
                  op.kind === "lease" ? [["leaseFence", op.fence]] : []
                ),
              ),
            })),
          } satisfies ServeWorkerMessage,
        );
      };
      setGrants = ({ grants }) => {
        server.ctx.policySnapshotLoader!.decisionService.snapshot =
          new PolicySnapshot(grants.map(toGrant), []);
        self.postMessage({ kind: "granted" } satisfies ServeWorkerMessage);
      };
      restrict = ({ types }) => {
        (server.ctx.authConfig as { restrictedModelTypes: string[] })
          .restrictedModelTypes = [...types];
        self.postMessage({ kind: "restricted" } satisfies ServeWorkerMessage);
      };
      compact = async ({ claim }) => {
        const store = server.v3.commitStore;
        const fence = store.writerFence();
        if (claim === true) {
          await store.claimOwner(
            fence ?? 1,
            DatastoreOwner.create({
              address: new URL(server.url).origin,
              claimedAt: new Date().toISOString(),
              claimedAtCursor: store.highWaterMark().cursor,
            }),
          );
        }
        const report = await store.compactHistory(
          store.highWaterMark().cursor,
          fence !== undefined ? { fence } : {},
        );
        self.postMessage(
          {
            kind: "compacted",
            point: report.point,
          } satisfies ServeWorkerMessage,
        );
      };
      write = async ({ dataName, dataId, count }) => {
        const { ctx } = server;
        const versions: number[] = [];
        const errors: string[] = [];
        for (let i = 0; i < count; i++) {
          try {
            const locks = await acquireModelLocks(
              ctx.datastoreConfig,
              [{ modelType: server.modelType.normalized, modelId: models.web }],
              ctx.repoDir,
              ctx.syncService,
              ctx.repoContext.catalogStore,
              () => {},
              { repoContext: ctx.repoContext },
            );
            versions.push(
              await runCommandInRootUnit(
                ctx.repoContext,
                { push: undefined, release: locks.release },
                async () =>
                  (await ctx.repoContext.unifiedDataRepo.save(
                    server.modelType,
                    models.web,
                    Data.create({
                      name: dataName,
                      id: dataId,
                      contentType: "application/json",
                      lifetime: "infinite",
                      garbageCollection: 10,
                      tags: { type: "resource" },
                      ownerDefinition: {
                        ownerType: "manual",
                        ownerRef: "test",
                      },
                    }),
                    new TextEncoder().encode(
                      JSON.stringify({ by: "serve", i }),
                    ),
                  )).version,
              ),
            );
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        self.postMessage(
          { kind: "wrote", versions, errors } satisfies ServeWorkerMessage,
        );
      };
      methodRun = async ({ modelIdOrName, methodName }) => {
        const frames = await sendRequest(
          server.ctx as ConnectionContext,
          {
            type: "model.method.run",
            id: crypto.randomUUID(),
            payload: { modelIdOrName, methodName },
          } as Parameters<typeof sendRequest>[1],
        );
        const errors = frames.flatMap((frame) => {
          const event = frame.event as
            | { kind?: string; error?: { message?: string } }
            | undefined;
          if (event?.kind === "error") {
            return [event.error?.message ?? JSON.stringify(event)];
          }
          return frame.error === undefined ? [] : [JSON.stringify(frame.error)];
        });
        self.postMessage(
          { kind: "ran-method", errors } satisfies ServeWorkerMessage,
        );
      };
      forceRelease = async ({ modelType, modelId }) => {
        const released = await server.locks.forceRelease({
          kind: "model",
          modelType,
          modelId,
        });
        self.postMessage(
          {
            kind: "force-released",
            ...(released === undefined ? {} : {
              principal: released.principal,
            }),
          } satisfies ServeWorkerMessage,
        );
      };
      runWorkflow = async ({ workflowName, initiatedBy, barrier }) => {
        if (barrier !== undefined) {
          registerBarrierReport(
            barrier.dir,
            barrier.label,
            barrier.labels,
            barrier.waitMs,
          );
        }
        const { ctx } = server;
        const events: WorkflowRunEvent[] = [];
        await executeWorkflowWithLocks(
          ctx.repoDir,
          ctx.repoContext,
          ctx.datastoreConfig,
          { workflowIdOrName: workflowName, initiatedBy },
          new AbortController().signal,
          (event) => events.push(event),
          ctx.syncService,
          undefined,
          { syncGate: undefined },
        );
        const statuses: string[] = [];
        const errors: string[] = [];
        for (const event of events) {
          if (event.kind === "completed") statuses.push(event.run.status);
          if (event.kind === "error") errors.push(event.error.message);
          if (event.kind === "report_failed") errors.push(event.error);
        }
        self.postMessage(
          {
            kind: "ran-workflow",
            statuses,
            errors,
          } satisfies ServeWorkerMessage,
        );
      };
      const stopped = new Promise<void>((resolve) => stop = resolve);
      self.postMessage(
        {
          kind: "ready",
          origin: new URL(server.url).origin,
          modelType: server.modelType.normalized,
          models,
          serveRepo: server.ctx.repoDir,
        } satisfies ServeWorkerMessage,
      );
      await stopped;
    },
    undefined,
    {
      managedConfig: request.managedConfig === true,
      locks: (createLock) => new CountingLeases({ createLock }),
      ...(request.servedAs === undefined
        ? {}
        : { serveAddress: request.servedAs }),
    },
  );
}

self.onmessage = (event: MessageEvent<ServeWorkerRequest>) => {
  const request = event.data;
  const fail = (error: unknown) =>
    self.postMessage(
      {
        kind: "failed",
        error: error instanceof Error ? error.stack ?? error.message : String(
          error,
        ),
      } satisfies ServeWorkerMessage,
    );
  if (request.kind === "start") {
    start(request).then(
      () => self.postMessage({ kind: "stopped" } satisfies ServeWorkerMessage),
      fail,
    );
  } else if (request.kind === "write") {
    (write ?? (() => Promise.reject(new Error("serve is not started"))))(
      request,
    ).catch(fail);
  } else if (request.kind === "compact") {
    (compact ?? (() => Promise.reject(new Error("serve is not started"))))(
      request,
    ).catch(fail);
  } else if (request.kind === "restrict") {
    try {
      if (restrict === undefined) throw new Error("serve is not started");
      restrict(request);
    } catch (error) {
      fail(error);
    }
  } else if (request.kind === "grants") {
    try {
      if (setGrants === undefined) throw new Error("serve is not started");
      setGrants(request);
    } catch (error) {
      fail(error);
    }
  } else if (request.kind === "lock-stats") {
    self.postMessage(
      {
        kind: "lock-stats",
        busy: busyAnswers,
        ownLockKeys: [...ownLockKeys],
      } satisfies ServeWorkerMessage,
    );
  } else if (request.kind === "method-run") {
    (methodRun ?? (() => Promise.reject(new Error("serve is not started"))))(
      request,
    ).catch(fail);
  } else if (request.kind === "renewals") {
    self.postMessage(
      {
        kind: "renewals",
        refused: refusedRenewals,
      } satisfies ServeWorkerMessage,
    );
  } else if (request.kind === "force-release") {
    (forceRelease ?? (() => Promise.reject(new Error("serve is not started"))))(
      request,
    ).catch(fail);
  } else if (request.kind === "run-workflow") {
    (runWorkflow ?? (() => Promise.reject(new Error("serve is not started"))))(
      request,
    ).catch(fail);
  } else if (request.kind === "log") {
    (log ?? (() => Promise.reject(new Error("serve is not started"))))()
      .catch(fail);
  } else {
    stop?.();
  }
};

// A request sent before the handler above is set can be lost when several
// workers load at once, so the test waits for this before its first.
self.postMessage({ kind: "loaded" } satisfies ServeWorkerMessage);
