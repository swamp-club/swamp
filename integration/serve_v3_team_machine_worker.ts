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
 * One serve node for the team-mode tests (swamp-club#4096): a worker with its
 * own module state, so its writer lease, handles and leadership are its own,
 * and its own host name as its writer lease sees it, so another node's lease
 * expires by its TTL as a remote holder's does. Its checkout is its own; the
 * filesystem datastore, its commits.db and its control plane are shared.
 * `pause` blocks the worker's thread as a stalled process would: its lease
 * renewals and leadership ticks stop.
 */

import { LOCK_TIMEOUT_ENV_VAR } from "../src/domain/datastore/datastore_config.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import {
  closeV3Datastores,
  enableV3ServeTeamMode,
  holdV3Writer,
  refreshV3FollowerCopy,
  v3ClaimCommitLog,
  v3DatastoreFor,
  v3ServeControlPlaneAt,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  acquireV3WriterLock,
  holdsCurrentV3WriterLease,
  v3WriterFence,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { ServeLeadership } from "../src/serve/serve_leadership.ts";
import { DatastoreOwner } from "../src/domain/datastore_v3/datastore_owner.ts";
import { commitIn } from "./datastore_v3_litestream_helpers.ts";

/** What the test asks a node to do. */
export type TeamNodeRequest =
  | {
    readonly kind: "init";
    readonly hostname: string;
    readonly datastorePath: string;
    readonly repoDir: string;
    readonly instanceId: string;
    /** Serve's `--address`, the owner a claim names. */
    readonly ownerAddress?: string;
  }
  /**
   * Serve's start: with `ttlMs`, the lease is first taken with that TTL, as
   * a short lease the test can let expire; then serve's hold, following
   * when another node holds the lease, and its leadership.
   */
  | { readonly kind: "start"; readonly ttlMs?: number; readonly tickMs: number }
  /** `swamp datastore claim --address` with serve stopped, then teardown. */
  | { readonly kind: "claim"; readonly address: string }
  /** The owner the node's copy shows. */
  | { readonly kind: "owner" }
  /** Serve's hold alone, before its leadership names the leader. */
  | { readonly kind: "hold" }
  | { readonly kind: "state" }
  /** One commit; resolves with the refusal's code, if any. */
  | { readonly kind: "commit" }
  | { readonly kind: "tick" }
  | { readonly kind: "pause"; readonly ms: number }
  /**
   * Burns the worker's thread for up to `ms`, as a node stuck in a busy
   * loop would: the test's request deadline must cut it off
   * (swamp-club#4152).
   */
  | { readonly kind: "spin"; readonly ms: number }
  | { readonly kind: "close" };

/** A node's answer. */
export type TeamNodeResponse =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: string; readonly code?: string };

/** What `state` answers. */
export interface TeamNodeState {
  readonly role: "leader" | "follower";
  readonly leader?: string;
  readonly fence?: number;
  readonly events: readonly string[];
}

declare const self: Worker;

let init: Extract<TeamNodeRequest, { kind: "init" }> | undefined;
let leadership: ServeLeadership | undefined;
let shortLease: (() => Promise<void>) | undefined;
const events: string[] = [];

function config(): FilesystemDatastoreConfig {
  return { type: "filesystem", path: init!.datastorePath };
}

async function handle(request: TeamNodeRequest): Promise<unknown> {
  switch (request.kind) {
    case "init": {
      init = request;
      await initializeLogging({});
      const realGet = Deno.env.get.bind(Deno.env);
      Object.defineProperty(Deno.env, "get", {
        configurable: true,
        value: (key: string) =>
          key === LOCK_TIMEOUT_ENV_VAR ? "1000" : realGet(key),
      });
      // Only the writer lease (v3_writer_lock.ts, writer_lease.ts) sees this
      // node's name, so another node's lease expires by its TTL as a remote
      // holder's does: the Workers share the test's pid. Realm-local, as is
      // the lock timeout above, which the lease renewals read after any one
      // request returns, so withMockedEnv cannot scope it.
      const hostname = request.hostname;
      const realHostname = Deno.hostname.bind(Deno);
      Object.defineProperty(Deno, "hostname", {
        configurable: true,
        value: () =>
          /v3_writer_lock\.ts|writer_lease\.ts/.test(new Error().stack ?? "")
            ? hostname
            : realHostname(),
      });
      return undefined;
    }
    case "start": {
      const datastorePath = init!.datastorePath;
      if (request.ttlMs !== undefined) {
        shortLease = await acquireV3WriterLock(datastorePath, {
          ttlMs: request.ttlMs,
          retakeLost: true,
        });
      }
      const ownerCheck = {
        as: "serve" as const,
        address: init!.ownerAddress,
      };
      const take = () =>
        holdV3Writer(config(), init!.repoDir, {
          retakeLost: true,
          follow: true,
          ownerCheck,
        });
      const role = await take();
      const node = new ServeLeadership({
        instanceId: init!.instanceId,
        address: `http://${init!.hostname}:9090`,
        lease: {
          holdsCurrent: () => holdsCurrentV3WriterLease(datastorePath),
          fence: () => v3WriterFence(datastorePath),
          take,
        },
        store: v3ServeControlPlaneAt(config()),
        refreshCopy: () => refreshV3FollowerCopy(init!.repoDir, config()),
        onLead: () => {
          events.push("lead");
          return Promise.resolve();
        },
        onLostLead: () => {
          events.push("lost");
          return Promise.resolve();
        },
        tickMs: request.tickMs,
      });
      leadership = node;
      enableV3ServeTeamMode(datastorePath, () => node.leader());
      await node.start(role);
      return role;
    }
    case "claim":
      try {
        await holdV3Writer(config(), init!.repoDir, {
          ownerCheck: { as: "claimer" },
        });
        const log = v3ClaimCommitLog(init!.repoDir, config());
        await log.catchUp(new AbortController().signal);
        await log.claim(DatastoreOwner.create({
          address: request.address,
          claimedAt: new Date().toISOString(),
          claimedAtCursor: log.highWaterCursor(),
        }));
        return undefined;
      } finally {
        await closeV3Datastores();
      }
    case "owner":
      return v3DatastoreFor(init!.repoDir, config()).commitStore.owner()
        ?.address;
    case "hold":
      return await holdV3Writer(config(), init!.repoDir, {
        retakeLost: true,
        follow: true,
        ownerCheck: { as: "serve", address: init!.ownerAddress },
      });
    case "state": {
      const leader = leadership?.leader();
      return {
        role: leadership!.role,
        ...(leader !== undefined ? { leader: leader.instanceId } : {}),
        ...(v3WriterFence(init!.datastorePath) !== undefined
          ? { fence: v3WriterFence(init!.datastorePath) }
          : {}),
        events: [...events],
      } satisfies TeamNodeState;
    }
    case "commit":
      try {
        await commitIn({ repoDir: init!.repoDir, config: config() }, 1);
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
    case "tick":
      await leadership!.tick();
      return undefined;
    case "pause":
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.ms);
      return undefined;
    case "spin": {
      // Bounded, so a terminate that failed to interrupt it costs the test
      // time, never the run.
      const end = Date.now() + request.ms;
      let spins = 0;
      while (Date.now() < end) spins++;
      return spins;
    }
    case "close":
      await leadership?.stop();
      await closeV3Datastores();
      await shortLease?.().catch(() => {});
      return undefined;
  }
}

self.onmessage = async (event: MessageEvent<TeamNodeRequest>) => {
  try {
    self.postMessage(
      { ok: true, value: await handle(event.data) } satisfies TeamNodeResponse,
    );
  } catch (error) {
    self.postMessage(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...((error as { code?: unknown }).code !== undefined
          ? { code: String((error as { code?: unknown }).code) }
          : {}),
      } satisfies TeamNodeResponse,
    );
  }
};
