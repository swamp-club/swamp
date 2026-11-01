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
 * A new leader adopting the explicit leases its predecessor kept
 * (swamp-club#4195) holds back only the writes to a key whose kept lease
 * it has not adopted yet (swamp-club#4258): every other write lands, and
 * every write waits while the kept leases cannot be read.
 */

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import type {
  PersistedLease,
  PersistedLeaseStore,
} from "../src/domain/datastore_v3/persisted_lease.ts";
import {
  DatastoreLockLeases,
  type LockTarget,
  type TryLock,
} from "../src/serve/datastore_locks.ts";
import {
  call,
  modelKey,
  save,
  type Server,
  withServer,
  writer,
} from "./serve_datastore_api_harness.ts";

const LEADER_FENCE = 2;

/**
 * The kept leases in memory, as the control plane keeps them: a record
 * written while the lease is granted is pending until it is, and adoption
 * returns every record that is not.
 */
function keptLeases(options: { unreadable?: () => boolean } = {}) {
  const records = new Map<string, PersistedLease>();
  const store: PersistedLeaseStore = {
    save: (_leaderFence, lease) => {
      records.set(lease.lockKey, lease);
      return Promise.resolve();
    },
    remove: (_leaderFence, lockKey) => {
      records.delete(lockKey);
      return Promise.resolve();
    },
    adopt: () =>
      options.unreadable?.()
        ? Promise.reject(new Error("control plane unreachable"))
        : Promise.resolve(
          [...records.values()].filter((lease) => lease.pending !== true),
        ),
  };
  return { records, store };
}

/** The lease the leader before kept for `principal` on `lockKey`. */
function kept(lockKey: string, principal = "user:caller"): PersistedLease {
  return {
    leaseId: crypto.randomUUID(),
    lockKey,
    principal,
    fence: 1,
    holdMs: 3_600_000,
    remainingMs: 3_600_000,
    recordedAt: new Date().toISOString(),
    leaderFence: 1,
  };
}

/**
 * Serve's own locks, with the keys in `blocked` held by a run of the
 * leader before: their kept leases cannot be adopted until they free.
 */
function leasesOver(
  persistence: PersistedLeaseStore,
  blocked: Set<string>,
): (
  createLock: (target: LockTarget) => Promise<TryLock>,
) => DatastoreLockLeases {
  return (createLock) =>
    new DatastoreLockLeases({
      createLock: async (target) => {
        const lock = await createLock(target);
        const key = target.kind === "model"
          ? `data/${target.modelType}/${target.modelId}/.lock`
          : `workflow-run-claims/${target.runId}/.lock`;
        return {
          tryAcquire: () =>
            blocked.has(key) ? Promise.resolve(false) : lock.tryAcquire(),
          release: () => lock.release(),
        };
      },
      persistence: { store: persistence, leaderFence: () => LEADER_FENCE },
      maxWaitMs: 20,
      retryIntervalMs: 5,
      adoptRetryMs: 10,
    });
}

/** Takes a fenced explicit lease on `lockKey`, as a checkout does. */
async function takeLease(
  server: Server,
  lockKey = modelKey(server),
): Promise<{ status: number; json: Record<string, unknown> }> {
  return await call(server, "POST", "locks", "alice-token", {
    lockKey,
    fenced: true,
    holdMs: 3_600_000,
    ttlMs: 3_600_000,
  });
}

function notLeader(
  reply: { status: number; json: Record<string, unknown> },
): boolean {
  return reply.status === 503 && reply.json.code === "serve_not_leader";
}

Deno.test({
  name:
    "datastore adoption gate: while one kept lease waits for its lock, writes to every other key land, and a lease taken meanwhile survives the adoption",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const other = `data/aws/ec2/${crypto.randomUUID()}/.lock`;
    const { records, store } = keptLeases();
    records.set(other, kept(other));
    const blocked = new Set([other]);
    await withServer(
      writer(),
      async (server) => {
        await server.locks.adopt();
        assert(server.locks.adopting, "the blocked lease is not adopted yet");

        // A commit to the behavior no pending lease covers lands.
        const saved = await save(server, "alice-token", 1, 0);
        assertEquals(saved.status, 200, JSON.stringify(saved.json));
        // So does an explicit lease on it.
        const taken = await takeLease(server);
        assertEquals(taken.status, 201, JSON.stringify(taken.json));
        const leaseId = taken.json.leaseId as string;
        // The lease listing waits: it would leave out the pending lease.
        assert(notLeader(await call(server, "GET", "locks", "alice-token")));

        // The run of the leader before ends; the retried adoption keeps the
        // lease taken meanwhile, recorded among the kept ones.
        blocked.clear();
        await waitFor(
          () => !server.locks.adopting,
          "the kept leases are adopted",
        );
        assertEquals(
          server.locks.lease("user:caller", leaseId)?.view.leaseId,
          leaseId,
        );
        assertEquals(
          (await call(server, "GET", "locks", "alice-token")).status,
          200,
        );
      },
      undefined,
      { locks: leasesOver(store, blocked) },
    );
  },
});

Deno.test({
  name:
    "datastore adoption gate: writes to a pending kept lease's key are refused retryably, then land once it is adopted",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { records, store } = keptLeases();
    const blocked = new Set<string>();
    await withServer(
      writer(),
      async (server) => {
        const key = modelKey(server);
        const lease = kept(key);
        records.set(key, lease);
        blocked.add(key);
        await server.locks.adopt();
        assert(server.locks.adopting, "the blocked lease is not adopted yet");

        assert(notLeader(await save(server, "alice-token", 1, 0)));
        assert(notLeader(await takeLease(server)));
        assert(
          notLeader(
            await call(server, "DELETE", "locks", "alice-token", {
              lockKey: key,
            }),
          ),
        );
        // Its holder's renewal and release are not answered as a lost lease.
        assert(
          notLeader(
            await call(
              server,
              "PUT",
              `locks/${lease.leaseId}`,
              "alice-token",
              { ttlMs: 3_600_000 },
            ),
          ),
        );
        assert(
          notLeader(
            await call(
              server,
              "DELETE",
              `locks/${lease.leaseId}`,
              "alice-token",
            ),
          ),
        );

        blocked.clear();
        await waitFor(
          () => !server.locks.adopting,
          "the kept leases are adopted",
        );
        const renewed = await call(
          server,
          "PUT",
          `locks/${lease.leaseId}`,
          "alice-token",
          { ttlMs: 3_600_000 },
        );
        assertEquals(renewed.status, 200, JSON.stringify(renewed.json));
        // The adopted lease decides commits as before the takeover.
        const leased = await save(server, "alice-token", 1, 0, {
          lease: lease.leaseId,
        });
        assertEquals(leased.status, 200, JSON.stringify(leased.json));
        const unleased = await save(server, "alice-token", 2, 1);
        assertEquals(unleased.json.code, "commit_lease-lost");
      },
      undefined,
      { locks: leasesOver(store, blocked) },
    );
  },
});

Deno.test({
  name:
    "datastore adoption gate: while the kept leases cannot be read, every write is refused retryably",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let unreadable = true;
    const { store } = keptLeases({ unreadable: () => unreadable });
    await withServer(
      writer(),
      async (server) => {
        await server.locks.adopt();
        assert(server.locks.adopting);

        assert(notLeader(await save(server, "alice-token", 1, 0)));
        assert(notLeader(await takeLease(server)));
        assert(
          notLeader(
            await call(server, "DELETE", "locks", "alice-token", {
              lockKey: `data/aws/ec2/${crypto.randomUUID()}/.lock`,
            }),
          ),
        );
        assert(
          notLeader(
            await call(
              server,
              "PUT",
              `locks/${crypto.randomUUID()}`,
              "alice-token",
              {},
            ),
          ),
        );

        unreadable = false;
        await waitFor(
          () => !server.locks.adopting,
          "the kept leases are adopted",
        );
        const saved = await save(server, "alice-token", 1, 0);
        assertEquals(saved.status, 200, JSON.stringify(saved.json));
      },
      undefined,
      { locks: leasesOver(store, new Set()) },
    );
  },
});
