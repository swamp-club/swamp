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
 * Serve's shared control plane in team mode on a v3 datastore
 * (swamp-club#4096): heartbeats, active runs and continuation claims live in
 * the datastore, so a new leader settles what the instance before it left,
 * whichever checkout that instance ran in. Closes swamp-club#3962: a run a
 * stopped serve left `running` is settled by the next leader, from a second
 * checkout or after a quick restart of the same one.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { isProcessGone } from "../src/infrastructure/runtime/process.ts";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import {
  createWorkflowId,
  type WorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { reapOrphanedWorkflowRuns } from "../src/domain/workflows/orphaned_run_reaper.ts";
import {
  serveHolder,
  suspensionKeyOf,
} from "../src/domain/workflows/continuation_claim.ts";
import {
  continuationClaimsOver,
  localServeControlPlane,
} from "../src/cli/repo_context.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { ControlPlaneSchedulePauseRepository } from "../src/infrastructure/persistence/control_plane_schedule_pause_repository.ts";
import { v3ServeControlPlaneAt } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  reconcileRemoteInterruptedRuns,
  teamModeRunLiveness,
} from "../src/serve/boot_reconciliation.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import { assertCheckoutsAgree, withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const NEW_LEADER = "new-leader";

/** A workflow run left `running` by serve instance `instanceId`. */
function runningRun(instanceId: string) {
  const workflowId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  return {
    workflowId,
    run: WorkflowRun.fromData({
      id: crypto.randomUUID(),
      workflowId,
      workflowName: "team",
      status: "running",
      startedAt,
      instanceId,
      pid: 1,
      jobs: [{
        jobName: "main",
        status: "running",
        startedAt,
        steps: [{ stepName: "noop", status: "running", startedAt }],
      }],
      tags: {},
    }),
  };
}

function inRoot<T>(repos: RowRepos, fn: () => Promise<T>): Promise<T> {
  return runInRootUnitOfWork(repos.a.repoContext, { flush: undefined }, fn);
}

/** The datastore's shared serve control plane, as A's serve opens it. */
function sharedStore(repos: RowRepos, datastorePath: string) {
  const config = repos.a.datastoreConfig;
  if (isCustomDatastoreConfig(config)) throw new Error("not filesystem");
  return v3ServeControlPlaneAt({ ...config, path: datastorePath });
}

async function heartbeat(
  store: ReturnType<typeof sharedStore>,
  instanceId: string,
  ageMs: number,
  stopped = false,
): Promise<void> {
  const at = new Date(Date.now() - ageMs).toISOString();
  await store.put(
    `heartbeats/${instanceId}`,
    new TextEncoder().encode(JSON.stringify({
      instanceId,
      hostname: "other-host",
      pid: 1,
      startedAt: at,
      heartbeatAt: at,
      ...(stopped ? { stoppedAt: at } : {}),
    })),
  );
}

async function statusOf(
  repos: RowRepos,
  workflowId: string,
  runId: string,
): Promise<string | undefined> {
  return (await repos.a.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflowId),
    runId as WorkflowRunId,
  ))?.status;
}

/** The boot reap serve's new leader runs, with team mode's rule. */
async function reapAsNewLeader(
  repos: RowRepos,
  store: ReturnType<typeof sharedStore>,
  tracker: (runId: string) => { status: string; instanceId?: string } | null,
): Promise<number> {
  const running = await repos.a.repoContext.workflowRunRepo
    .findGlobalByStatus("running");
  const result = await inRoot(
    repos,
    () =>
      reapOrphanedWorkflowRuns(
        running,
        (wid, run) => repos.a.repoContext.workflowRunRepo.save(wid, run),
        tracker,
        isProcessGone,
        NEW_LEADER,
        teamModeRunLiveness(NEW_LEADER, store).isAlive,
        { judgeForeignRows: true },
      ),
  );
  return result.reaped;
}

Deno.test("serve team mode: the new leader settles a run the stopped leader left running, and the settlement commits", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const store = sharedStore(repos, datastorePath);
    const { workflowId, run } = runningRun("old-leader");
    await inRoot(
      repos,
      () =>
        repos.a.repoContext.workflowRunRepo.save(
          createWorkflowId(workflowId),
          run,
        ),
    );
    // Its heartbeat is still fresh: in team mode that keeps nothing alive.
    await heartbeat(store, "old-leader", 1_000);
    assertEquals(await reapAsNewLeader(repos, store, () => null), 1);
    assertEquals(await statusOf(repos, workflowId, run.id), "interrupted");
    await assertCheckoutsAgree(repos, datastorePath, "team-mode reap");
  });
});

Deno.test("serve team mode: a quick restart of the same checkout settles the run its previous serve left (swamp-club#3962)", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const store = sharedStore(repos, datastorePath);
    const { workflowId, run } = runningRun("previous-serve");
    await inRoot(
      repos,
      () =>
        repos.a.repoContext.workflowRunRepo.save(
          createWorkflowId(workflowId),
          run,
        ),
    );
    // Restarted within 90 s: the tracker row was reopened as running under
    // the old instance id, and the old heartbeat is recent and stopped.
    await heartbeat(store, "previous-serve", 54_000, true);
    const reaped = await reapAsNewLeader(
      repos,
      store,
      () => ({ status: "running", instanceId: "previous-serve" }),
    );
    assertEquals(reaped, 1);
    assertEquals(await statusOf(repos, workflowId, run.id), "interrupted");
  });
});

Deno.test("serve team mode: reconciliation settles a demoted leader's runs while it still heartbeats, and leaves a follower alone", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const store = sharedStore(repos, datastorePath);
    const { workflowId, run } = runningRun("demoted");
    await inRoot(
      repos,
      () =>
        repos.a.repoContext.workflowRunRepo.save(
          createWorkflowId(workflowId),
          run,
        ),
    );
    await heartbeat(store, "demoted", 1_000);
    await heartbeat(store, "follower", 1_000);
    // The record a running workflow's leader keeps for it.
    await store.put(
      `active-runs/demoted/${run.id}`,
      new TextEncoder().encode(JSON.stringify({
        instanceId: "demoted",
        resourceName: "team",
        resourceId: workflowId,
        runKind: "workflow",
        startedAt: new Date().toISOString(),
      })),
    );
    const reaped = await reconcileRemoteInterruptedRuns({
      controlPlaneStore: store,
      instanceId: NEW_LEADER,
      runTracker: {
        findAllRunning: () => [],
        complete: () => {},
      } as unknown as Parameters<
        typeof reconcileRemoteInterruptedRuns
      >[0]["runTracker"],
      workflowRunRepo: repos.a.repoContext.workflowRunRepo,
      markDirty: repos.a.repoContext.markDirty,
      isPeerGone: teamModeRunLiveness(NEW_LEADER, store).isPeerGone,
      resolveWorkflowId: () => Promise.resolve(workflowId),
    });
    assertEquals(reaped, 1);
    assertEquals(await statusOf(repos, workflowId, run.id), "interrupted");
    assertEquals(await store.get("heartbeats/follower") !== null, true);
  });
});

Deno.test("serve team mode: a continuation claim the old leader took is seen by the new leader, held by an instance it judges dead", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const store = sharedStore(repos, datastorePath);
    const { run } = runningRun("old-leader");
    const claim = {
      runId: run.id,
      suspensionKey: await suspensionKeyOf(run),
      generation: 1,
      holder: serveHolder("old-leader"),
      claimedAt: new Date().toISOString(),
    };
    const old = continuationClaimsOver(store, serveHolder("old-leader"));
    assertEquals(await old.store.create(claim), true);
    await heartbeat(store, "old-leader", 1_000, true);
    const next = continuationClaimsOver(store, serveHolder(NEW_LEADER));
    assertEquals(
      await next.store.find(claim.runId, claim.suspensionKey),
      claim,
    );
    assertEquals(await next.liveness(claim.holder), "dead");
  });
});

Deno.test("serve team mode: local token and schedule commands write where serve on a v3 datastore reads", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    const local = await localServeControlPlane(repos.repoA);
    await local.put(
      "token-secrets/values/minted-locally",
      new TextEncoder().encode("secret"),
    );
    const served = sharedStore(repos, datastorePath);
    assertEquals(
      await served.get("token-secrets/values/minted-locally") !== null,
      true,
    );
    // A pause set without --server is one serve's scheduler sees.
    const workflowId = crypto.randomUUID();
    await new ControlPlaneSchedulePauseRepository(local).save({
      workflowId,
      workflowName: "nightly",
      pausedBy: "user:caller",
      pausedAt: new Date().toISOString(),
    });
    const seen = await new ControlPlaneSchedulePauseRepository(served).get(
      createWorkflowId(workflowId),
    );
    assertEquals(seen?.workflowName, "nightly");
  });
});

Deno.test("serve team mode: a token command run before serve restarts moves the checkout's token secrets with their key, so older tokens still resolve", async () => {
  await withV3RowRepos({}, async (repos, datastorePath) => {
    // What a serve from before team mode kept in the checkout.
    const checkout = new FileSystemControlPlaneStore(swampPath(repos.repoA));
    await checkout.put(
      "token-secrets/encryption-key",
      new TextEncoder().encode("checkout-key"),
    );
    await checkout.put(
      "token-secrets/values/old-token",
      new TextEncoder().encode("old-secret"),
    );
    // The upgraded CLI's token command opens serve's store first.
    await localServeControlPlane(repos.repoA);
    const served = sharedStore(repos, datastorePath);
    assertEquals(
      new TextDecoder().decode(
        (await served.get("token-secrets/encryption-key"))!,
      ),
      "checkout-key",
    );
    assertEquals(
      await served.get("token-secrets/values/old-token") !== null,
      true,
    );
  });
});
