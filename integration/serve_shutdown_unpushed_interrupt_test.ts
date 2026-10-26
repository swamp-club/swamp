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
 * A clean `swamp serve` stop whose push of the interrupted runs misses its
 * deadline must not leave the datastore holding those runs `running`
 * (swamp-club#3958). Wires the real shutdown interrupt, run repository, run
 * tracker, instance heartbeat, reconciliation and boot reaper on a temp
 * filesystem. The datastore is a directory: a push copies the cache's run
 * records to it, as a sync service's first push after a start walks the
 * whole cache, and a refresh copies one record back.
 */

import { assertEquals } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { copy, ensureDir } from "@std/fs";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import type {
  WorkflowId,
  WorkflowRunId,
} from "../src/domain/workflows/workflow_id.ts";
import { ActiveRun } from "../src/domain/models/active_run.ts";
import type { ControlPlaneStore } from "../src/domain/datastore/control_plane_store.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { RunTrackerStore } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { interruptShutdownRuns } from "../src/serve/shutdown_interrupt.ts";
import { InstanceHeartbeatService } from "../src/serve/instance_heartbeat.ts";
import { reconcileRemoteInterruptedRuns } from "../src/serve/boot_reconciliation.ts";
import {
  markedRunsStillRunning,
  pushSettledAtBoot,
  readUnpushedInterrupts,
  UNPUSHED_INTERRUPTS_FILE,
} from "../src/serve/unpushed_interrupts.ts";
import { reapOrphanedWorkflowRuns } from "../src/domain/workflows/orphaned_run_reaper.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const OWNER = "owner-instance";
const PEER = "peer-instance";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function inMemoryControlPlane(): ControlPlaneStore & {
  entries: Map<string, Uint8Array>;
} {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    put: (key, data) => {
      entries.set(key, data);
      return Promise.resolve();
    },
    putIfAbsent: (key, data) => {
      if (entries.has(key)) return Promise.resolve(false);
      entries.set(key, data);
      return Promise.resolve(true);
    },
    get: (key) => Promise.resolve(entries.get(key) ?? null),
    delete: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        [...entries.keys()].filter((k) => k.startsWith(prefix)).sort(),
      ),
  };
}

function workflow(): Workflow {
  return Workflow.create({
    name: `slow-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "sleep", task: StepTask.model("m", "run") }),
        ],
      }),
    ],
  });
}

/** One checkout: a repository dir, its run records and its run tracker. */
function checkout(dir: string) {
  return {
    dir,
    runs: new YamlWorkflowRunRepository(dir),
    tracker: RunTrackerStore.fromSwampDir(swampPath(dir)),
    runsDir: swampPath(dir, SWAMP_SUBDIRS.workflowRuns),
  };
}

type Checkout = ReturnType<typeof checkout>;

/** The datastore: a directory holding pushed run records. */
function datastore(dir: string) {
  const runsDir = join(dir, SWAMP_SUBDIRS.workflowRuns);
  return {
    runs: new YamlWorkflowRunRepository(dir, undefined, runsDir),
    /** Copies every run record in `from` here, as a full-walk push. */
    pushFrom: async (from: Checkout) => {
      await ensureDir(runsDir);
      await copy(from.runsDir, runsDir, { overwrite: true });
    },
    /** Copies one run record of `into` back from here. */
    refreshInto: async (
      into: Checkout,
      workflowId: WorkflowId,
      runId: WorkflowRunId,
    ) => {
      const target = into.runs.getPath(workflowId, runId);
      const source = join(runsDir, relative(into.runsDir, target));
      await ensureDir(dirname(target));
      await Deno.copyFile(source, target);
    },
  };
}

/**
 * The owner's state when SIGTERM arrives: a run mid-step, pushed while
 * running, with its tracker row, active-run record and heartbeat.
 */
async function startRun(
  owner: Checkout,
  remote: ReturnType<typeof datastore>,
  control: ControlPlaneStore,
) {
  const wf = workflow();
  const run = WorkflowRun.create(wf);
  run.start(Deno.pid, OWNER);
  run.getJob("main")!.start();
  run.getJob("main")!.getStep("sleep")!.start();
  await owner.runs.save(wf.id, run);
  await remote.pushFrom(owner);
  const now = new Date().toISOString();
  owner.tracker.register(ActiveRun.fromData({
    id: run.id,
    runKind: "workflow",
    modelType: null,
    methodName: null,
    workflowName: run.workflowName,
    pid: Deno.pid,
    hostname: Deno.hostname(),
    instanceId: OWNER,
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  }));
  await control.put(
    `active-runs/${OWNER}/${run.id}`,
    new TextEncoder().encode(JSON.stringify({
      instanceId: OWNER,
      resourceName: run.workflowName,
      resourceId: wf.id,
      runKind: "workflow-run",
      startedAt: now,
    })),
  );
  const heartbeat = new InstanceHeartbeatService(control, OWNER, {
    intervalMs: 60_000,
  });
  await heartbeat.start();
  return { wf, run, heartbeat };
}

/** The owner's shutdown against a datastore too slow for the push. */
async function stopWithSlowDatastore(
  owner: Checkout,
  run: WorkflowRun,
  heartbeat: InstanceHeartbeatService,
) {
  const result = await interruptShutdownRuns(
    [{ runId: run.id, kind: "workflow-run", startedAt: new Date() }],
    {
      repoContext: {
        markDirty: () => Promise.resolve(),
        workflowRunRepo: owner.runs,
      },
      // A push that settles only when its deadline aborts it.
      syncService: {
        pushChanged: (options) =>
          new Promise((_, reject) =>
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal!.reason),
            )
          ),
      },
      pushTimeoutMs: 20,
      runTracker: owner.tracker,
      unpushedMarkerPath: swampPath(owner.dir, UNPUSHED_INTERRUPTS_FILE),
    },
  );
  await heartbeat.stop({
    leaveStoppedRecord: (result.unpushed?.length ?? 0) > 0,
  });
  return result;
}

Deno.test("shutdown with an unpushed interrupt: a peer whose cache lacks the run settles it in the datastore (swamp-club#3958)", async () => {
  await withTempDir(async (dir) => {
    const owner = checkout(join(dir, "owner"));
    const peer = checkout(join(dir, "peer"));
    const remote = datastore(join(dir, "remote"));
    const control = inMemoryControlPlane();
    try {
      const { wf, run, heartbeat } = await startRun(owner, remote, control);

      const result = await stopWithSlowDatastore(owner, run, heartbeat);

      assertEquals(result.unpushed, [run.id]);
      assertEquals(owner.tracker.findById(run.id)?.status, "interrupted");
      assertEquals(
        (await remote.runs.findById(wf.id, run.id))?.status,
        "running",
      );
      const record = InstanceHeartbeatService.parseRecord(
        control.entries.get(`heartbeats/${OWNER}`)!,
      );
      assertEquals(InstanceHeartbeatService.isStopped(record!), true);

      const reaped = await reconcileRemoteInterruptedRuns({
        controlPlaneStore: control,
        instanceId: PEER,
        runTracker: peer.tracker,
        workflowRunRepo: peer.runs,
        refreshRunRecord: (workflowId, runId) =>
          remote.refreshInto(peer, workflowId, runId),
        pushReaped: () => remote.pushFrom(peer),
      });

      assertEquals(reaped, 1);
      assertEquals(
        (await remote.runs.findById(wf.id, run.id))?.status,
        "interrupted",
      );
      assertEquals(await control.list(`active-runs/${OWNER}/`), []);
      assertEquals(await control.get(`heartbeats/${OWNER}`), null);
    } finally {
      owner.tracker.close();
      peer.tracker.close();
    }
  });
});

Deno.test("shutdown with an unpushed interrupt: a failed stopped-heartbeat write leaves the last heartbeat, reconciled once stale", async () => {
  await withTempDir(async (dir) => {
    const owner = checkout(join(dir, "owner"));
    const peer = checkout(join(dir, "peer"));
    const remote = datastore(join(dir, "remote"));
    const control = inMemoryControlPlane();
    try {
      const { wf, run, heartbeat } = await startRun(owner, remote, control);
      // The last periodic heartbeat, written two minutes ago.
      const longAgo = new Date(Date.now() - 120_000).toISOString();
      await control.put(
        `heartbeats/${OWNER}`,
        new TextEncoder().encode(JSON.stringify({
          instanceId: OWNER,
          hostname: Deno.hostname(),
          pid: Deno.pid,
          startedAt: longAgo,
          heartbeatAt: longAgo,
        })),
      );
      const put = control.put;
      control.put = (key, data) =>
        key.startsWith("heartbeats/")
          ? Promise.reject(new Error("S3 unreachable"))
          : put(key, data);

      await stopWithSlowDatastore(owner, run, heartbeat);

      const record = InstanceHeartbeatService.parseRecord(
        control.entries.get(`heartbeats/${OWNER}`)!,
      );
      assertEquals(record?.heartbeatAt, longAgo);
      control.put = put;

      const reaped = await reconcileRemoteInterruptedRuns({
        controlPlaneStore: control,
        instanceId: PEER,
        runTracker: peer.tracker,
        workflowRunRepo: peer.runs,
        refreshRunRecord: (workflowId, runId) =>
          remote.refreshInto(peer, workflowId, runId),
        pushReaped: () => remote.pushFrom(peer),
      });

      assertEquals(reaped, 1);
      assertEquals(
        (await remote.runs.findById(wf.id, run.id))?.status,
        "interrupted",
      );
    } finally {
      owner.tracker.close();
      peer.tracker.close();
    }
  });
});

for (
  const { name, hydrationReplaced } of [
    { name: "its cache still holds the interrupt", hydrationReplaced: false },
    {
      name: "boot hydration replaced it with the datastore's running record",
      hydrationReplaced: true,
    },
  ]
) {
  Deno.test(`shutdown with an unpushed interrupt: a restart of the same checkout pushes it when ${name}`, async () => {
    await withTempDir(async (dir) => {
      const owner = checkout(join(dir, "owner"));
      const remote = datastore(join(dir, "remote"));
      const control = inMemoryControlPlane();
      try {
        const { wf, run, heartbeat } = await startRun(
          owner,
          remote,
          control,
        );
        await stopWithSlowDatastore(owner, run, heartbeat);
        if (hydrationReplaced) {
          await remote.refreshInto(owner, wf.id, run.id as WorkflowRunId);
        }

        // The next serve's boot reap, as serve runs it.
        const markerPath = swampPath(owner.dir, UNPUSHED_INTERRUPTS_FILE);
        const marker = await readUnpushedInterrupts(markerPath);
        assertEquals(marker, {
          present: true,
          runs: [{ runId: run.id, workflowId: wf.id }],
        });
        let reaped = 0;
        await runInRootUnitOfWork(
          { markDirty: () => Promise.resolve() },
          {
            flush: () =>
              pushSettledAtBoot({
                reaped,
                marker,
                markerPath,
                push: () => remote.pushFrom(owner),
              }),
            pushWhen: "completed",
          },
          async () => {
            const runningRuns = await owner.runs.findGlobalByStatus(
              "running",
            );
            for (
              const marked of await markedRunsStillRunning(
                marker,
                (workflowId, runId) => owner.runs.findById(workflowId, runId),
              )
            ) {
              if (!runningRuns.some(({ run }) => run.id === marked.run.id)) {
                runningRuns.push(marked);
              }
            }
            const result = await reapOrphanedWorkflowRuns(
              runningRuns,
              (wid, r) => owner.runs.save(wid, r),
              (runId) => {
                const tracked = owner.tracker.findById(runId);
                return tracked ? { status: tracked.status } : null;
              },
              () => true,
              "restarted-instance",
              () => Promise.resolve(false),
            );
            reaped = result.reaped;
          },
        );

        assertEquals(reaped, hydrationReplaced ? 1 : 0);
        assertEquals(
          (await remote.runs.findById(wf.id, run.id))?.status,
          "interrupted",
        );
        assertEquals(await readUnpushedInterrupts(markerPath), {
          present: false,
        });
      } finally {
        owner.tracker.close();
      }
    });
  });
}
