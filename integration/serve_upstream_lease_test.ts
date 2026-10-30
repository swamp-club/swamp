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
 * Fenced model leases in team mode (swamp-club#4121), end to end: serve in
 * a Worker, checkouts writing through it as commands do.
 *
 * - A run-only caller (no `read` on the behavior's data) saves above the
 *   floor its lease carries, so `version-live` never comes back.
 * - A lease serve stops renewing (a revoked grant) lapses, and the lapse
 *   fires the signal that cancels the run under it.
 * - An explicit lease (`swamp model lease acquire`) holds the behavior
 *   across commands: a command in the checkout uses it, and another
 *   caller's write waits for it.
 * - A command whose renewal of the checkout's lease meets a serve blip
 *   still names the lease, and a lease serve no longer holds does not
 *   refuse its commit (swamp-club#4167).
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../src/cli/repo_context.ts";
import { runCommandInRootUnit } from "../src/cli/command_root_unit.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  acquireExplicitLease,
  ExplicitLeaseHeldError,
  readExplicitLeases,
  releaseExplicitLease,
} from "../src/infrastructure/datastore_v3/explicit_model_leases.ts";
import { ServeLeaseLapsedError } from "../src/infrastructure/datastore_v3/serve_lock.ts";
import { PartitionsRefusedError } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { serveUpstreamAt } from "../src/infrastructure/datastore_v3/serve_upstream_registry.ts";
import { resetServeLeasesForTesting } from "../src/infrastructure/datastore_v3/serve_lease_registry.ts";
import { resetLeaseRenewalsForTesting } from "../src/infrastructure/datastore_v3/serve_upstream_binding.ts";
import {
  resolveDatastoreForRepo,
  v3LocationOf,
} from "../src/cli/repo_context.ts";
import {
  type Client,
  dataOf,
  endCommand,
  json,
  MEMBER,
  type Scratch,
  type Serve,
  serveEnv,
  withClientEnv,
  withScratch,
  writeCommand,
} from "./serve_upstream_fixtures.ts";
import type { GrantSpec } from "./serve_upstream_server_worker.ts";

await initializeLogging({});

const DATA_ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a41";

/** Bob may run web and write its data, but never read its data. */
const BOB_RUN_ONLY: readonly GrantSpec[] = [
  ...MEMBER,
  { user: "bob", actions: ["read", "run"], kind: "model", pattern: "web" },
  { user: "bob", actions: ["write"], kind: "data", pattern: "web" },
];

/**
 * One locked save of `out` on web in `client`, as `model method run` takes
 * the lock: resolves with the version it saved, or throws.
 */
async function lockedSave(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  label: string,
): Promise<number> {
  const type = serve.modelType;
  return await withClientEnv(
    scratch,
    serveEnv(serve, token),
    ["model", "method"],
    async () => {
      try {
        const ctx = await requireInitializedRepoUnlocked({
          repoDir: client.repoDir,
          outputMode: "json",
        });
        const locks = await acquireModelLocks(
          ctx.datastoreConfig,
          [{ modelType: type.normalized, modelId: serve.models.web }],
          client.repoDir,
          ctx.syncService,
          ctx.repoContext.catalogStore,
          () => {},
          { repoContext: ctx.repoContext },
        );
        return await runCommandInRootUnit(
          ctx.repoContext,
          { push: undefined, release: locks.release },
          async () =>
            (await ctx.repoContext.unifiedDataRepo.save(
              type,
              serve.models.web,
              dataOf("out", DATA_ID),
              json({ by: label }),
            )).version,
        );
      } finally {
        await endCommand();
      }
    },
  );
}

Deno.test({
  name:
    "serve upstream leases: a run-only caller saves above the floor of versions it cannot read, and version-live never comes back",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: BOB_RUN_ONLY });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      for (let i = 0; i < 3; i++) {
        assertEquals(
          await lockedSave(scratch, serve, alice, "alice-token", "alice"),
          i + 1,
        );
      }
      assertEquals(
        await lockedSave(scratch, serve, bob, "bob-token", "bob"),
        4,
      );
      assertEquals(
        await lockedSave(scratch, serve, alice, "alice-token", "alice"),
        5,
      );
      assertEquals(
        await lockedSave(scratch, serve, bob, "bob-token", "bob"),
        6,
      );
      const versions = (await serve.log())
        .flatMap((entry) => entry.keys)
        .filter((key) => key.includes("/out/") && key.endsWith("/raw"));
      assertEquals(versions.length, 6);
    });
  },
});

Deno.test({
  name:
    "serve upstream leases: a lease serve stops renewing lapses, firing the signal that cancels the run under it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve();
      const alice = await scratch.client("a");
      const type = ModelType.create(serve.modelType.normalized);
      await withClientEnv(
        scratch,
        serveEnv(serve, "alice-token"),
        ["model", "method"],
        async () => {
          try {
            const ctx = await requireInitializedRepoUnlocked({
              repoDir: alice.repoDir,
              outputMode: "json",
            });
            const locks = await acquireModelLocks(
              ctx.datastoreConfig,
              [{ modelType: type.normalized, modelId: serve.models.web }],
              alice.repoDir,
              ctx.syncService,
              ctx.repoContext.catalogStore,
              () => {},
              { repoContext: ctx.repoContext },
            );
            try {
              assert(locks.leaseLost !== undefined);
              assertEquals(locks.leaseLost.aborted, false);
              // The grant that let alice hold the lock is revoked: the next
              // renewal is refused, and the lease lapses.
              await serve.setGrants([]);
              await waitFor(
                () => locks.leaseLost!.aborted,
                "the lease to lapse",
                { timeoutMs: 30_000 },
              );
              assertInstanceOf(locks.leaseLost.reason, ServeLeaseLapsedError);
            } finally {
              await locks.release();
            }
          } finally {
            await endCommand();
          }
        },
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream leases: an explicit lease holds the behavior across commands; a command in the checkout uses it, and another caller cannot take it",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants: readonly GrantSpec[] = [
      ...MEMBER,
      { user: "bob", actions: ["read", "run"], kind: "model", pattern: "*" },
      { user: "bob", actions: ["read", "write"], kind: "data", pattern: "*" },
    ];
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      const lockKey =
        `data/${serve.modelType.normalized}/${serve.models.web}/.lock`;
      const env = serveEnv(serve, "alice-token");
      const inAlice = <T>(fn: (root: string) => Promise<T>) =>
        withClientEnv(scratch, env, ["model", "lease"], async () => {
          try {
            const resolution = await resolveDatastoreForRepo(alice.repoDir);
            const root = (await v3LocationOf(resolution)).path;
            return await fn(root);
          } finally {
            await endCommand();
          }
        });

      const taken = await inAlice(async (root) => {
        const client = serveUpstreamAt(root)!.client();
        try {
          return await acquireExplicitLease(
            root,
            client,
            lockKey,
            600_000,
            5_000,
            new AbortController().signal,
          );
        } finally {
          client.close();
        }
      });
      assertEquals(taken.existing, false);

      // Another command of alice's checkout uses the lease, and leaves it.
      assertEquals(
        await lockedSave(scratch, serve, alice, "alice-token", "alice"),
        1,
      );
      assertEquals(
        await lockedSave(scratch, serve, alice, "alice-token", "alice"),
        2,
      );
      const recorded = await inAlice((root) => readExplicitLeases(root));
      assertEquals(recorded.map((lease) => lease.leaseId), [
        taken.lease.leaseId,
      ]);
      // Every save landed under the lease's fence.
      const fenced = (await serve.log()).filter((entry) =>
        entry.leaseFence === taken.lease.fence
      );
      assert(fenced.length > 0);

      // A command that takes no lock (a read-kind method saves data without
      // one) still names the checkout's lease, so serve takes its commit.
      // It starts as a new process does: nothing registered, nothing renewed.
      resetServeLeasesForTesting();
      resetLeaseRenewalsForTesting();
      const lockless = await writeCommand(
        scratch,
        alice,
        env,
        async (repos) =>
          (await repos.unifiedDataRepo.save(
            serve.modelType,
            serve.models.web,
            dataOf("out", DATA_ID),
            json({ by: "alice, lockless" }),
          )).version,
      );
      assertEquals(lockless, 3);

      // Bob cannot take the lock while alice's lease holds it.
      await withClientEnv(
        scratch,
        serveEnv(serve, "bob-token"),
        ["model", "lease"],
        async () => {
          try {
            const resolution = await resolveDatastoreForRepo(bob.repoDir);
            const root = (await v3LocationOf(resolution)).path;
            const client = serveUpstreamAt(root)!.client();
            try {
              await assertRejects(
                () =>
                  acquireExplicitLease(
                    root,
                    client,
                    lockKey,
                    60_000,
                    0,
                    new AbortController().signal,
                  ),
                ExplicitLeaseHeldError,
              );
            } finally {
              client.close();
            }
          } finally {
            await endCommand();
          }
        },
      );

      await inAlice(async (root) => {
        const client = serveUpstreamAt(root)!.client();
        try {
          assert(
            await releaseExplicitLease(
              root,
              client,
              lockKey,
              new AbortController().signal,
            ),
          );
        } finally {
          client.close();
        }
      });
      assertEquals(
        await lockedSave(scratch, serve, bob, "bob-token", "bob"),
        4,
      );
    });
  },
});

Deno.test({
  name:
    "serve upstream leases: a run-only caller under one explicit lease saves above its own earlier writes, command after command",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: BOB_RUN_ONLY });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      for (let i = 0; i < 3; i++) {
        await lockedSave(scratch, serve, alice, "alice-token", "alice");
      }
      const lockKey =
        `data/${serve.modelType.normalized}/${serve.models.web}/.lock`;
      await withClientEnv(
        scratch,
        serveEnv(serve, "bob-token"),
        ["model", "lease"],
        async () => {
          try {
            const resolution = await resolveDatastoreForRepo(bob.repoDir);
            const root = (await v3LocationOf(resolution)).path;
            const client = serveUpstreamAt(root)!.client();
            try {
              await acquireExplicitLease(
                root,
                client,
                lockKey,
                600_000,
                5_000,
                new AbortController().signal,
              );
            } finally {
              client.close();
            }
          } finally {
            await endCommand();
          }
        },
      );
      // Each save is a command of its own, in a process of its own: bob's
      // copy never sees his own landed versions, so only the lease's floor,
      // raised by each landed commit, keeps the next one above them.
      const versions: number[] = [];
      for (let i = 0; i < 3; i++) {
        resetServeLeasesForTesting();
        resetLeaseRenewalsForTesting();
        versions.push(
          await lockedSave(scratch, serve, bob, "bob-token", "bob"),
        );
      }
      assertEquals(versions, [4, 5, 6]);
    });
  },
});

/**
 * Runs `fn` while the first lease renewal (`PUT locks/{leaseId}`) this
 * process sends fails as a serve blip would (swamp-club#4167).
 */
async function withRenewalBlip<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  let blips = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (blips === 0 && init?.method === "PUT" && url.includes("/locks/")) {
      blips++;
      return Promise.reject(new TypeError("connection reset by serve"));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    assertEquals(blips, 1);
  }
}

/** A lease command in `client`: `fn` gets the checkout's v3 root. */
async function inLeaseCommand<T>(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  return await withClientEnv(
    scratch,
    serveEnv(serve, token),
    ["model", "lease"],
    async () => {
      try {
        const resolution = await resolveDatastoreForRepo(client.repoDir);
        return await fn((await v3LocationOf(resolution)).path);
      } finally {
        await endCommand();
      }
    },
  );
}

/** Takes an explicit lease on `lockKey` in the checkout at `root`. */
async function takeExplicitLease(root: string, lockKey: string) {
  const client = serveUpstreamAt(root)!.client();
  try {
    return await acquireExplicitLease(
      root,
      client,
      lockKey,
      600_000,
      5_000,
      new AbortController().signal,
    );
  } finally {
    client.close();
  }
}

/**
 * One lockless save of `out` on web in `client`, as a read-kind method
 * saves, in a fresh process whose renewal of the checkout's leases blips.
 */
async function locklessSaveThroughBlip(
  scratch: Scratch,
  serve: Serve,
  client: Client,
  token: string,
  label: string,
): Promise<number> {
  resetServeLeasesForTesting();
  resetLeaseRenewalsForTesting();
  return await withRenewalBlip(() =>
    writeCommand(
      scratch,
      client,
      serveEnv(serve, token),
      async (repos) =>
        (await repos.unifiedDataRepo.save(
          serve.modelType,
          serve.models.web,
          dataOf("out", DATA_ID),
          json({ by: label }),
        )).version,
    )
  );
}

Deno.test({
  name:
    "serve upstream leases: a lockless save whose renewal of the checkout's lease blipped still lands under the lease (swamp-club#4167)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants: MEMBER });
      const alice = await scratch.client("a");
      const lockKey =
        `data/${serve.modelType.normalized}/${serve.models.web}/.lock`;
      const taken = await inLeaseCommand(
        scratch,
        serve,
        alice,
        "alice-token",
        (root) => takeExplicitLease(root, lockKey),
      );
      assertEquals(
        await locklessSaveThroughBlip(
          scratch,
          serve,
          alice,
          "alice-token",
          "alice, blipped",
        ),
        1,
      );
      const log = await serve.log();
      assertEquals(log.at(-1)?.leaseFence, taken.lease.fence);
    });
  },
});

Deno.test({
  name:
    "serve upstream leases: a recorded lease serve no longer holds does not refuse a lockless save through a blip, and another caller's lease still does (swamp-club#4167)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const grants: readonly GrantSpec[] = [
      ...MEMBER,
      { user: "bob", actions: ["read", "run"], kind: "model", pattern: "*" },
      { user: "bob", actions: ["read", "write"], kind: "data", pattern: "*" },
    ];
    await withScratch(async (scratch) => {
      const serve = await scratch.serve({ grants });
      const alice = await scratch.client("a");
      const bob = await scratch.client("b");
      const lockKey =
        `data/${serve.modelType.normalized}/${serve.models.web}/.lock`;
      // Serve forgets alice's lease while her checkout still records it,
      // as a serve that restarted would.
      await inLeaseCommand(
        scratch,
        serve,
        alice,
        "alice-token",
        async (root) => {
          const taken = await takeExplicitLease(root, lockKey);
          const client = serveUpstreamAt(root)!.client();
          try {
            await client.releaseLock(
              taken.lease.leaseId,
              new AbortController().signal,
            );
          } finally {
            client.close();
          }
        },
      );
      assertEquals(
        await locklessSaveThroughBlip(
          scratch,
          serve,
          alice,
          "alice-token",
          "alice, lease gone",
        ),
        1,
      );
      assertEquals((await serve.log()).at(-1)?.leaseFence, undefined);

      // Bob's live lease still refuses alice's unleased resend.
      await inLeaseCommand(
        scratch,
        serve,
        bob,
        "bob-token",
        (root) => takeExplicitLease(root, lockKey),
      );
      const refused = await assertRejects(() =>
        locklessSaveThroughBlip(
          scratch,
          serve,
          alice,
          "alice-token",
          "alice, under bob's lease",
        )
      );
      assertInstanceOf(refused, PartitionsRefusedError);
      assertEquals(refused.reason, "lease-lost");
    });
  },
});
