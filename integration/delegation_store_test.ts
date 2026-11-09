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

import "../src/domain/models/models.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  endDelegation,
  issueDelegationTokens,
  recordApproval,
  recordReported,
  startDelegation,
} from "../src/domain/access/delegation.ts";
import { Ceiling } from "../src/domain/access/ceiling.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import {
  DelegationStore,
  DelegationWriteFailed,
} from "../src/serve/delegation_store.ts";
import { endLocally } from "../src/serve/delegation_link_service.ts";
import { withServeRepo } from "./serve_request_harness.ts";

await initializeLogging({});

Deno.test("DelegationStore: a write whose push fails is restored once, and a failing restore never loops", async () => {
  await withServeRepo(async (repo) => {
    let pushes = 0;
    let failPushes = false;
    let reloads = 0;
    const store = new DelegationStore({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      lock: () =>
        Promise.resolve({
          synced: false,
          push: () => {
            pushes++;
            return failPushes
              ? Promise.reject(new Error("push refused"))
              : Promise.resolve();
          },
          release: () => Promise.resolve(),
        }),
      directory: {
        reload: () => {
          reloads++;
          return Promise.resolve();
        },
      },
    });
    const now = Date.now();
    const started = startDelegation({
      id: crypto.randomUUID(),
      integrationId: "slack-bot",
      external: {
        platform: "slack",
        teamId: "T",
        userId: "U",
        display: "Pat",
        workspace: "W",
      },
      ceiling: Ceiling.parse({ version: 1, ceiling: [] }),
      ceilingDigest: "sha256:x",
      redeemHash: `sha256:${"a".repeat(64)}`,
      requestId: "r",
      digest: "d",
      consentExpiresAt: new Date(now + 600_000).toISOString(),
      pollIntervalSeconds: 5,
    }, now);
    const consented = recordReported(
      recordApproval(started, {
        sub: "s",
        email: "e@x",
        collectives: [],
        groups: [],
      }, now),
      "link",
      now,
    );
    await store.create(consented);

    failPushes = true;
    pushes = 0;
    await assertRejects(
      () =>
        store.transition(consented.id, async (current) => {
          const issued = await issueDelegationTokens(current!, now);
          return { write: issued.record, value: issued.tokens };
        }),
      DelegationWriteFailed,
    );
    // the write's push, then the restore's, and nothing more
    assertEquals(pushes, 2);
    // the restore wrote the consented record back locally, so nothing a later
    // push publishes holds tokens no caller received
    assertEquals((await store.read(consented.id))?.phase, "consented");
    assertEquals((await store.read(consented.id))?.tokens, undefined);
    assertEquals(reloads >= 2, true);
  });
});

Deno.test("DelegationStore: an end whose push fails is kept, never undone", async () => {
  await withServeRepo(async (repo) => {
    let failPushes = false;
    const store = new DelegationStore({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      lock: () =>
        Promise.resolve({
          synced: false,
          push: () =>
            failPushes
              ? Promise.reject(new Error("push refused"))
              : Promise.resolve(),
          release: () => Promise.resolve(),
        }),
      directory: { reload: () => Promise.resolve() },
    });
    const now = Date.now();
    const consented = recordReported(
      recordApproval(
        startDelegation({
          id: crypto.randomUUID(),
          integrationId: "slack-bot",
          external: {
            platform: "slack",
            teamId: "T",
            userId: "U",
            display: "Pat",
            workspace: "W",
          },
          ceiling: Ceiling.parse({ version: 1, ceiling: [] }),
          ceilingDigest: "sha256:x",
          redeemHash: `sha256:${"a".repeat(64)}`,
          requestId: "r",
          digest: "d",
          consentExpiresAt: new Date(now + 600_000).toISOString(),
          pollIntervalSeconds: 5,
        }, now),
        { sub: "s", email: "e@x", collectives: [], groups: [] },
        now,
      ),
      "link",
      now,
    );
    await store.create(consented);
    failPushes = true;
    await assertRejects(
      () =>
        store.transition(consented.id, (current) =>
          Promise.resolve({
            write: endDelegation(current!, "operator", now),
            value: undefined,
          })),
      DelegationWriteFailed,
    );
    assertEquals((await store.read(consented.id))?.phase, "ended");
  });
});

Deno.test("DelegationStore: a record this build can't read is refused and its lock released, so the next change does not block", async () => {
  await withServeRepo(async (repo) => {
    let held = 0;
    const store = new DelegationStore({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      lock: () => {
        if (held > 0) {
          return Promise.reject(new Error("lock still held"));
        }
        held++;
        return Promise.resolve({
          synced: false,
          push: () => Promise.resolve(),
          release: () => {
            held--;
            return Promise.resolve();
          },
        });
      },
      directory: { reload: () => Promise.resolve() },
    });
    const id = crypto.randomUUID();
    const original = repo.repoContext.unifiedDataRepo.getContent.bind(
      repo.repoContext.unifiedDataRepo,
    );
    repo.repoContext.unifiedDataRepo.getContent = (
      type: Parameters<typeof original>[0],
      modelId: string,
      dataName: string,
      version?: number,
    ) =>
      modelId === id
        ? Promise.resolve(
          new TextEncoder().encode(JSON.stringify({ id, phase: "sideways" })),
        )
        : original(type, modelId, dataName, version);
    try {
      for (let i = 0; i < 2; i++) {
        await assertRejects(() =>
          endLocally(store, id, "operator", Date.now())
        );
        assertEquals(held, 0);
      }
      assertEquals(await store.readOrNull(id), null);
    } finally {
      repo.repoContext.unifiedDataRepo.getContent = original;
    }
  });
});
