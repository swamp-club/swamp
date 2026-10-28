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

// Serve for serve_upstream_test.ts (swamp-club#3985): the datastore API test
// server over a real v3 repository, in a Worker of its own, so the client
// checkouts the test opens in the main thread can end their commands
// (closeV3Datastores, the serve-upstream registry resets) as the CLI does
// without closing serve's handle or releasing its writer lease.

import "../src/domain/models/models.ts";
import { acquireModelLocks } from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DatastoreOwner } from "../src/domain/datastore_v3/datastore_owner.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { withServer } from "./serve_datastore_api_harness.ts";
import { grant } from "./serve_request_harness.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";

/** One grant, as the test spells it across the worker boundary. */
export interface GrantSpec {
  /** The user the grant is for; the harness's caller (alice) when absent. */
  readonly user?: string;
  readonly actions: readonly string[];
  readonly kind: string;
  readonly pattern: string;
}

export type ServeWorkerRequest =
  | {
    readonly kind: "start";
    readonly grants: readonly GrantSpec[];
    /** Behaviors serve's repo holds besides `web`, by name. */
    readonly models?: readonly string[];
    /** Serve's datastore holds the repository's config (`managedConfig`). */
    readonly managedConfig?: boolean;
  }
  | { readonly kind: "log" }
  /**
   * Replaces the grants serve enforces, as a reload of its access data
   * does (swamp-club#4089).
   */
  | { readonly kind: "grants"; readonly grants: readonly GrantSpec[] }
  /**
   * Compacts serve's whole log (swamp-club#4006), and with `claim` has
   * serve claim its datastore first, as `swamp datastore claim` does.
   */
  | { readonly kind: "compact"; readonly claim?: boolean }
  /**
   * Serve's own work: `count` saves of a version of `dataName` on behavior
   * `web`, one after another, each under serve's lock on it as serve's
   * method runs take it.
   */
  | {
    readonly kind: "write";
    readonly dataName: string;
    readonly dataId: string;
    readonly count: number;
  }
  | { readonly kind: "stop" };

/** One commit of serve's log, as the test reads it. */
export interface ServeLogEntry {
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
  readonly principal: string | undefined;
  readonly keys: readonly string[];
}

export type ServeWorkerMessage =
  /** The module is evaluated and its handler set: requests may be sent. */
  | { readonly kind: "loaded" }
  | {
    readonly kind: "ready";
    /** Serve's origin, as `SWAMP_SERVE_URL` names it. */
    readonly origin: string;
    readonly modelType: string;
    /** The behaviors serve's repo holds, by name: their ids. */
    readonly models: Readonly<Record<string, string>>;
    readonly serveRepo: string;
  }
  | { readonly kind: "log"; readonly entries: readonly ServeLogEntry[] }
  | { readonly kind: "compacted"; readonly point: number }
  | { readonly kind: "granted" }
  | {
    readonly kind: "wrote";
    readonly versions: readonly number[];
    readonly errors: readonly string[];
  }
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly error: string };

declare const self: Worker;

// Not awaited at the top level: the handler must be set before the test's
// first message arrives.
const logging = initializeLogging({});

let stop: (() => void) | undefined;
let log: (() => Promise<void>) | undefined;
let setGrants:
  | ((request: Extract<ServeWorkerRequest, { kind: "grants" }>) => void)
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
  await withServer(
    request.grants.map(toGrant),
    async (server) => {
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
        // The commits after the compaction point: those before are folded.
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
            })),
          } satisfies ServeWorkerMessage,
        );
      };
      setGrants = ({ grants }) => {
        server.ctx.policySnapshotLoader!.decisionService.snapshot =
          new PolicySnapshot(grants.map(toGrant), []);
        self.postMessage({ kind: "granted" } satisfies ServeWorkerMessage);
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
    { managedConfig: request.managedConfig === true },
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
  } else if (request.kind === "grants") {
    try {
      if (setGrants === undefined) throw new Error("serve is not started");
      setGrants(request);
    } catch (error) {
      fail(error);
    }
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
