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
import { assertEquals } from "@std/assert";
import { Data } from "../src/domain/data/data.ts";
import { EventBus } from "../src/domain/events/event_bus.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
} from "../src/domain/models/access/grant_model.ts";
import {
  POLICY_RELEASE_DATA_NAME,
  POLICY_RELEASE_ID,
  POLICY_RELEASE_MODEL_TYPE,
} from "../src/domain/models/access/policy_release_model.ts";
import { PolicyRelease } from "../src/domain/access/policy_release.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  createPolicyReleaseWriter,
  PolicyReleasePublisher,
} from "../src/serve/policy_release_publisher.ts";
import { withServeRepo } from "./serve_request_harness.ts";

await initializeLogging({});

function grant(id: string, name: string): Grant {
  return {
    id,
    subject: { kind: "user", name },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "workflow", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

async function saveGrant(
  repoContext: RepositoryContext,
  modelId: string,
  attrs: Grant,
): Promise<void> {
  await repoContext.unifiedDataRepo.save(
    GRANT_MODEL_TYPE,
    modelId,
    Data.create({
      name: "grant-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: modelId },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${GRANT_MODEL_TYPE.normalized}:${modelId}`,
      },
    }),
    new TextEncoder().encode(JSON.stringify(attrs)),
  );
}

async function storedRelease(
  repoContext: RepositoryContext,
): Promise<PolicyRelease> {
  const content = await repoContext.unifiedDataRepo.getContent(
    POLICY_RELEASE_MODEL_TYPE,
    POLICY_RELEASE_ID,
    POLICY_RELEASE_DATA_NAME,
  );
  if (content === null) throw new Error("no release stored");
  return PolicyRelease.parse(JSON.parse(new TextDecoder().decode(content)));
}

Deno.test("policy release: a held grant reaches no follower until the leader rebuilds, then reaches every one", async () => {
  await withServeRepo(async (repo) => {
    const { repoContext, repoDir } = repo;
    let pushes = 0;
    const publisher = new PolicyReleasePublisher({
      fence: () => 3,
      write: createPolicyReleaseWriter({
        repoDir,
        repoContext,
        lock: () =>
          Promise.resolve({
            synced: false,
            push: () => {
              pushes++;
              return Promise.resolve();
            },
            release: () => Promise.resolve(),
          }),
      }),
    });
    const leader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      repoContext.eventBus,
      "manual",
    );
    leader.onBuilt((release) => publisher.offer(release));
    // the follower reads the same records, as a team's copy does
    const follower = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      new EventBus(),
      "manual",
    );
    try {
      await saveGrant(repoContext, "g-adam", grant("g1", "adam"));
      await leader.load();
      await publisher.settled();
      assertEquals(pushes, 1);
      await follower.applyRelease(await storedRelease(repoContext));
      assertEquals(
        follower.snapshot.grantsForSubjects(["user:adam"]).length,
        1,
      );

      // written by the leader, held by manual mode
      await saveGrant(repoContext, "g-eve", grant("g2", "eve"));
      await publisher.settled();
      assertEquals(pushes, 1);
      await follower.applyRelease(await storedRelease(repoContext));
      assertEquals(leader.snapshot.grantsForSubjects(["user:eve"]).length, 0);
      assertEquals(follower.snapshot.grantsForSubjects(["user:eve"]).length, 0);

      await leader.load();
      await publisher.settled();
      assertEquals(pushes, 2);
      await follower.applyRelease(await storedRelease(repoContext));
      assertEquals(follower.snapshot.grantsForSubjects(["user:eve"]).length, 1);
      assertEquals(follower.release().digest(), leader.release().digest());

      await leader.load();
      await publisher.settled();
      assertEquals(pushes, 2);
    } finally {
      await publisher.stop();
      await leader.dispose();
      await follower.dispose();
    }
  });
});
