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

import { assert, assertEquals } from "@std/assert";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { GRANT_MODEL_TYPE } from "../src/domain/models/access/grant_model.ts";
import { EventBus } from "../src/domain/events/event_bus.ts";
import {
  POLICY_RELEASE_DATA_NAME,
  POLICY_RELEASE_ID,
  POLICY_RELEASE_MODEL_TYPE,
} from "../src/domain/models/access/policy_release_model.ts";
import { PolicyRelease } from "../src/domain/access/policy_release.ts";
import {
  createPolicyReleaseWriter,
  PolicyReleasePublisher,
} from "../src/serve/policy_release_publisher.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  type Frame,
  sendRequest,
  withServeRepo,
} from "./serve_request_harness.ts";

await initializeLogging({});

const PROBE = {
  principal: { kind: "user" as const, id: "probe" },
  collectives: [],
  groups: [],
  client: undefined,
  delegation: undefined,
};
const RESOURCE = { kind: "model", name: "anything", fields: {} } as const;

function grantRun(
  methodName: string,
  inputs: Record<string, unknown>,
  definitionName: string,
) {
  return {
    type: "model.method.run",
    id: crypto.randomUUID(),
    payload: {
      modelIdOrName: `@${GRANT_MODEL_TYPE.normalized}`,
      methodName,
      inputs,
      typeArg: `@${GRANT_MODEL_TYPE.normalized}`,
      definitionName,
    },
  };
}

function finished(frames: Frame[]): string {
  const error = frames.find((f) =>
    f.type === "error" ||
    (f.event as { kind?: string } | undefined)?.kind === "error"
  );
  return error === undefined ? "ok" : "error";
}

/** serve with a real policy loader in manual mode, as `swamp serve` defaults */
function serveWithManualPolicy(
  repo: Parameters<Parameters<typeof withServeRepo>[0]>[0],
): { ctx: ConnectionContext; loader: PolicySnapshotLoader } {
  const loader = new PolicySnapshotLoader(
    repo.repoContext.unifiedDataRepo,
    repo.repoContext.eventBus,
    "manual",
  );
  const ctx = {
    // as in production, where serve always tracks its active runs
    ...createServeCtx(repo, undefined, { detached: true }),
    policySnapshotLoader: loader,
  } as ConnectionContext;
  return { ctx, loader };
}

const allowsProbe = (loader: PolicySnapshotLoader) =>
  loader.decisionService.decide(PROBE, "run", RESOURCE)?.effect === "allow";

Deno.test("serve grant runs: in manual reload mode a grant created through serve is enforced when the run is answered (swamp-club#5073)", async () => {
  await withServeRepo(async (repo) => {
    const { ctx, loader } = serveWithManualPolicy(repo);
    await loader.load();
    assertEquals(allowsProbe(loader), false);

    const frames = await sendRequest(
      ctx,
      grantRun("create", {
        subject: "user:probe",
        effect: "allow",
        actions: ["run", "read"],
        resourceKind: "model",
        resourcePattern: "*",
        source: "method",
        createdBy: "user:local",
      }, "grant-probe"),
      null,
    );

    assertEquals(finished(frames), "ok", JSON.stringify(frames));
    assertEquals(allowsProbe(loader), true);
  });
});

Deno.test("serve grant runs: in manual reload mode a revoke through serve is enforced when the run is answered (swamp-club#5073)", async () => {
  await withServeRepo(async (repo) => {
    const { ctx, loader } = serveWithManualPolicy(repo);
    await sendRequest(
      ctx,
      grantRun("create", {
        subject: "user:probe",
        effect: "allow",
        actions: ["run"],
        resourceKind: "model",
        resourcePattern: "*",
        source: "method",
        createdBy: "user:local",
      }, "grant-revoked"),
      null,
    );
    assertEquals(allowsProbe(loader), true);

    const frames = await sendRequest(
      ctx,
      grantRun("revoke", {}, "grant-revoked"),
      null,
    );

    assertEquals(finished(frames), "ok", JSON.stringify(frames));
    assertEquals(allowsProbe(loader), false);
  });
});

Deno.test("serve grant runs: a policy rebuild that fails answers the grant run with an error (swamp-club#5073)", async () => {
  await withServeRepo(async (repo) => {
    const { ctx, loader } = serveWithManualPolicy(repo);
    loader.load = () => Promise.reject(new Error("policy store unreadable"));

    const frames = await sendRequest(
      ctx,
      grantRun("create", {
        subject: "user:probe",
        effect: "allow",
        actions: ["run"],
        resourceKind: "model",
        resourcePattern: "*",
        source: "method",
        createdBy: "user:local",
      }, "grant-unbuilt"),
      null,
    );

    assert(finished(frames) === "error", JSON.stringify(frames));
  });
});

Deno.test("serve grant runs: a grant created through a team leader in manual mode reaches its follower's policy, and a revoke leaves it (swamp-club#5073)", async () => {
  await withServeRepo(async (repo) => {
    const { repoContext, repoDir } = repo;
    const publisher = new PolicyReleasePublisher({
      fence: () => 3,
      write: createPolicyReleaseWriter({
        repoDir,
        repoContext,
        lock: () =>
          Promise.resolve({
            synced: false,
            push: () => Promise.resolve(),
            release: () => Promise.resolve(),
          }),
      }),
    });
    const { ctx, loader: leader } = serveWithManualPolicy(repo);
    leader.onBuilt((release) => publisher.offer(release));
    // the follower reads the same records, as a team's copy does, and
    // enforces only the leader's release
    const follower = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      new EventBus(),
      "manual",
    );
    const adoptRelease = async () => {
      await publisher.settled();
      const content = await repoContext.unifiedDataRepo.getContent(
        POLICY_RELEASE_MODEL_TYPE,
        POLICY_RELEASE_ID,
        POLICY_RELEASE_DATA_NAME,
      );
      if (content === null) throw new Error("no release stored");
      await follower.applyRelease(
        PolicyRelease.parse(JSON.parse(new TextDecoder().decode(content))),
      );
    };
    try {
      await leader.load();
      await adoptRelease();
      assertEquals(allowsProbe(follower), false);

      await sendRequest(
        ctx,
        grantRun("create", {
          subject: "user:probe",
          effect: "allow",
          actions: ["run"],
          resourceKind: "model",
          resourcePattern: "*",
          source: "method",
          createdBy: "user:local",
        }, "grant-team"),
        null,
      );
      await adoptRelease();
      assertEquals(allowsProbe(leader), true);
      assertEquals(allowsProbe(follower), true);

      await sendRequest(ctx, grantRun("revoke", {}, "grant-team"), null);
      await adoptRelease();
      assertEquals(allowsProbe(leader), false);
      assertEquals(allowsProbe(follower), false);
    } finally {
      await publisher.stop();
      await leader.dispose();
      await follower.dispose();
    }
  });
});
