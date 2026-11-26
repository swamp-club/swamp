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

// runs on one behavior of a v3 filesystem datastore, each in a process of its
// own, take its lock in the order they queued for it

import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  createModelLock,
  resolveDatastoreForRepo,
} from "../src/cli/repo_context.ts";
import type {
  DistributedLock,
  LockInfo,
} from "../src/domain/datastore/distributed_lock.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  formatTicketName,
  fsLockQueueOps,
  lockQueueDir,
  overrideTicketTtlForTesting,
  ownHostIdHash,
} from "../src/infrastructure/persistence/lock_queue.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreLockReleaseDeps,
  datastoreLockRelease,
  modelLockKey,
} from "../src/libswamp/datastores/lock.ts";
import { collect } from "../src/libswamp/testing.ts";
import { type ProcessHost, startProcessHost } from "./process_host.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

type LockRequest =
  | {
    readonly kind: "acquire";
    readonly repoDir: string;
    readonly modelType: string;
    readonly modelId: string;
    /** held until a release request, rather than released at once */
    readonly hold?: boolean;
    readonly ticketTtlMs?: number;
  }
  | { readonly kind: "release" }
  | { readonly kind: "close" };

type LockMessage =
  | { readonly acquired: string }
  | { readonly released: string }
  | { readonly closed: string }
  | { readonly failed: string };

function lockHost(name: string): ProcessHost<LockRequest, LockMessage> {
  return (post) => {
    let held: DistributedLock | undefined;
    let ttl: Disposable | undefined;
    const acquire = async (
      request: Extract<LockRequest, { kind: "acquire" }>,
    ) => {
      if (request.ticketTtlMs !== undefined) {
        ttl = overrideTicketTtlForTesting(request.ticketTtlMs);
      }
      const { datastoreConfig } = await resolveDatastoreForRepo(
        request.repoDir,
      );
      const lock = await createModelLock(
        datastoreConfig,
        request.modelType,
        request.modelId,
      );
      await lock.acquire();
      post({ acquired: name });
      if (request.hold === true) {
        held = lock;
        return;
      }
      await lock.release();
      post({ released: name });
    };
    const release = async () => {
      await held?.release();
      held = undefined;
      post({ released: name });
    };
    const close = async () => {
      await held?.release();
      held = undefined;
      ttl?.[Symbol.dispose]();
      await closeV3Datastores();
      await flushDatastoreSync();
      post({ closed: name });
    };
    const failed = (error: unknown) => post({ failed: `${name}: ${error}` });
    return (request) => {
      switch (request.kind) {
        case "acquire":
          acquire(request).catch(failed);
          return;
        case "release":
          release().catch(failed);
          return;
        case "close":
          close().catch(failed);
          return;
      }
    };
  };
}

interface Lab {
  readonly repoDirs: readonly [string, string];
  readonly modelType: string;
  readonly modelId: string;
  readonly lockPath: string;
  readonly queueDir: string;
  readonly messages: LockMessage[];
  start(name: string, request?: { hold?: boolean; ticketTtlMs?: number }): {
    release(): void;
  };
  seen(test: (message: LockMessage) => boolean, what: string): Promise<void>;
  tickets(): Promise<string[]>;
  acquiredOrder(): string[];
}

async function withLab(fn: (lab: Lab) => Promise<void>): Promise<void> {
  await withV3RowRepos({}, async (repos) => {
    const { datastoreConfig } = await resolveDatastoreForRepo(repos.repoA);
    if (isCustomDatastoreConfig(datastoreConfig)) {
      throw new Error("expected a filesystem datastore");
    }
    assertEquals(datastoreConfig.format, 3);
    const modelType = repos.modelType.normalized;
    const modelId = crypto.randomUUID();
    const lockKey = modelLockKey(datastoreConfig.namespace, modelType, modelId);
    const messages: LockMessage[] = [];
    const hosts: { name: string; postMessage(r: LockRequest): void }[] = [];
    const repoDirs = [repos.repoA, repos.repoB] as const;
    const seen = async (
      test: (message: LockMessage) => boolean,
      what: string,
    ) => {
      await waitFor(
        () => messages.some(test) || messages.some((m) => "failed" in m),
        what,
        { timeoutMs: 120_000 },
      );
      const failure = messages.find((m) => "failed" in m);
      if (failure !== undefined && "failed" in failure) {
        throw new Error(failure.failed);
      }
    };
    const lab: Lab = {
      repoDirs,
      modelType,
      modelId,
      lockPath: join(datastoreConfig.path, lockKey),
      queueDir: await lockQueueDir(datastoreConfig.path, undefined, lockKey),
      messages,
      start(name, request = {}) {
        const host = startProcessHost<LockRequest, LockMessage>(
          name,
          lockHost(name),
          (message) => messages.push(message),
        );
        hosts.push({ name, postMessage: (r) => host.postMessage(r) });
        host.postMessage({
          kind: "acquire",
          repoDir: repoDirs[hosts.length % 2],
          modelType,
          modelId,
          ...request,
        });
        return { release: () => host.postMessage({ kind: "release" }) };
      },
      seen,
      async tickets() {
        return ((await fsLockQueueOps.list(lab.queueDir)) ?? []).map((t) =>
          t.name
        ).sort();
      },
      acquiredOrder: () =>
        messages.flatMap((m) => "acquired" in m ? [m.acquired] : []),
    };
    try {
      await fn(lab);
    } finally {
      for (const host of hosts) host.postMessage({ kind: "close" });
      await waitFor(
        () =>
          hosts.every((h) =>
            messages.some((m) =>
              ("closed" in m && m.closed === h.name) ||
              ("failed" in m && m.failed.startsWith(`${h.name}:`))
            )
          ),
        "every process closed",
        { timeoutMs: 120_000 },
      );
    }
  });
}

/** queues each waiter only once the one before it holds a ticket, so arrival order is known */
async function queueWaiters(
  lab: Lab,
  names: readonly string[],
  request: { ticketTtlMs?: number } = {},
  planted?: string,
): Promise<void> {
  for (const [i, name] of names.entries()) {
    lab.start(name, request);
    await waitFor(
      async () =>
        (await lab.tickets()).filter((t) => t !== planted).length === i + 1,
      `${name} queued`,
      { timeoutMs: 120_000 },
    );
  }
}

async function allAcquired(lab: Lab, names: readonly string[]) {
  for (const name of names) {
    await lab.seen((m) => "released" in m && m.released === name, name);
  }
}

function lockRecord(acquiredAt: Date): LockInfo {
  return {
    holder: "run@another-host",
    hostname: "another-host",
    pid: Deno.pid,
    acquiredAt: acquiredAt.toISOString(),
    ttlMs: 30_000,
    nonce: crypto.randomUUID(),
  };
}

async function writeWhole(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(temp, content);
  await Deno.rename(temp, path);
}

const WAITERS = Array.from({ length: 8 }, (_, i) => `waiter-${i}`);

Deno.test({
  name:
    "model lock fair queue: eight runs queued behind a holder take the behavior's lock in the order they arrived",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLab(async (lab) => {
      const holder = lab.start("holder", { hold: true });
      await lab.seen((m) => "acquired" in m && m.acquired === "holder", "held");
      await queueWaiters(lab, WAITERS);
      holder.release();
      await allAcquired(lab, WAITERS);
      assertEquals(lab.acquiredOrder(), ["holder", ...WAITERS]);
      assertEquals(await lab.tickets(), []);
    });
  },
});

Deno.test({
  name:
    "model lock fair queue: a waiter on another host that died in the queue is skipped once its heartbeat has stood still for the TTL",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLab(async (lab) => {
      const ttl = { ticketTtlMs: 2_000 };
      const holder = lab.start("holder", { hold: true, ...ttl });
      await lab.seen((m) => "acquired" in m && m.acquired === "holder", "held");
      const own = await ownHostIdHash();
      const dead = formatTicketName({
        seq: 1,
        hostIdHash: own === "ffffffff" ? "eeeeeeee" : "ffffffff",
        pid: Deno.pid,
        nonce: "0".repeat(32),
      });
      await Deno.mkdir(lab.queueDir, { recursive: true });
      await Deno.writeTextFile(join(lab.queueDir, dead), "");
      const waiters = WAITERS.slice(0, 3);
      await queueWaiters(lab, waiters, ttl, dead);
      holder.release();
      await allAcquired(lab, waiters);
      assertEquals(lab.acquiredOrder(), ["holder", ...waiters]);
      assertEquals(await lab.tickets(), []);
    });
  },
});

Deno.test({
  name:
    "model lock fair queue: when the holder on another host dies, the head of the queue clears its lock and the rest follow in order",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLab(async (lab) => {
      await writeWhole(
        lab.lockPath,
        JSON.stringify(lockRecord(new Date())),
      );
      const waiters = WAITERS.slice(0, 4);
      await queueWaiters(lab, waiters);
      assertEquals(lab.acquiredOrder(), []);
      // its heartbeat stopped a TTL ago
      await writeWhole(
        lab.lockPath,
        JSON.stringify(lockRecord(new Date(Date.now() - 600_000))),
      );
      await allAcquired(lab, waiters);
      assertEquals(lab.acquiredOrder(), waiters);
    });
  },
});

Deno.test({
  name:
    "model lock fair queue: a force release hands the behavior's lock to the head of the queue",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLab(async (lab) => {
      const stuck = lockRecord(new Date());
      await writeWhole(lab.lockPath, JSON.stringify(stuck));
      const waiters = WAITERS.slice(0, 3);
      await queueWaiters(lab, waiters);
      const { datastoreConfig } = await resolveDatastoreForRepo(
        lab.repoDirs[0],
      );
      const events = await collect(datastoreLockRelease(
        createLibSwampContext(),
        createDatastoreLockReleaseDeps(
          await createModelLock(datastoreConfig, lab.modelType, lab.modelId),
        ),
      ));
      const completed = events.find((e) => e.kind === "completed");
      assert(completed !== undefined && completed.kind === "completed");
      assertEquals(completed.data.released, true);
      assertEquals(completed.data.previousHolder?.nonce, stuck.nonce);
      await allAcquired(lab, waiters);
      assertEquals(lab.acquiredOrder(), waiters);
    });
  },
});
