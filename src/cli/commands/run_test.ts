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
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { hostname } from "node:os";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import "../../domain/models/models.ts";
import { diagnoseLocalRuns } from "./run.ts";
import {
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import type { MethodRunOutputs } from "../../domain/workflows/orphaned_run_reaper.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type {
  WorkflowId,
  WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

await initializeLogging({});

const WORKFLOW_ID = "5b0e6c3c-2b7e-4c55-9d43-3c1f2f0e9a11" as WorkflowId;
// Where the records of a workflow renamed since its runs live.
const RENAMED_WORKFLOW_ID =
  "8f6d1e2a-0c4b-4d7e-9a3f-1b2c3d4e5f60" as WorkflowId;
// Far above any real pid_max, so never a live process.
const DEAD_PID = 2147483647;

function withTracker(
  fn: (tracker: RunTrackerStore, dir: string) => Promise<void>,
) {
  return async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-run-doctor-test-" });
    const tracker = new RunTrackerStore(join(dir, "run_tracker.db"));
    try {
      await fn(tracker, dir);
    } finally {
      tracker.close();
      await Deno.remove(dir, { recursive: true }).catch(
        Deno.build.os === "windows" ? () => {} : (e) => {
          throw e;
        },
      );
    }
  };
}

/** A run left `running` by a force exit: one step done, one in flight. */
function strandedRun(pid: number): WorkflowRun {
  const startedAt = new Date().toISOString();
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: WORKFLOW_ID,
    workflowName: "wf",
    status: "running",
    startedAt,
    pid,
    jobs: [{
      jobName: "main",
      status: "running",
      startedAt,
      steps: [
        { stepName: "gate", status: "succeeded", startedAt },
        { stepName: "s", status: "running", startedAt },
      ],
    }],
    tags: {},
  });
}

function trackerRow(
  id: string,
  pid: number,
  runKind: "workflow" | "model_method" = "workflow",
  host = hostname(),
): ActiveRun {
  const now = new Date().toISOString();
  return ActiveRun.fromData({
    id,
    runKind,
    modelType: runKind === "model_method" ? "command/shell" : null,
    methodName: runKind === "model_method" ? "execute" : null,
    workflowName: runKind === "workflow" ? "wf" : null,
    pid,
    hostname: host,
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  });
}

type DoctorRunRepository = WorkflowRunRepository & {
  listWorkflowIds(): Promise<WorkflowId[]>;
};

/**
 * A run repository over `runs`, stored under workflow "wf", and `renamed`,
 * stored under a workflow no longer named so. `scanned` limits what the
 * recent-record scan returns, as its window does for a run started long ago.
 */
function runRepoOf(
  runs: WorkflowRun[],
  scanned = runs,
  renamed: WorkflowRun[] = [],
): {
  runRepo: DoctorRunRepository;
  saved: string[];
} {
  const saved: string[] = [];
  const stored = new Map<WorkflowId, WorkflowRun[]>([
    [WORKFLOW_ID, runs],
    [RENAMED_WORKFLOW_ID, renamed],
  ]);
  const runRepo = {
    findGlobalByStatus: (status: string) =>
      Promise.resolve(
        scanned.filter((r) => r.status === status).map((run) => ({
          run,
          workflowId: WORKFLOW_ID,
        })),
      ),
    findById: (wfId: WorkflowId, runId: WorkflowRunId) =>
      Promise.resolve(
        stored.get(wfId)?.find((r) => r.id === (runId as string)) ?? null,
      ),
    listWorkflowIds: () => Promise.resolve([...stored.keys()]),
    save: (_wfId: WorkflowId, run: WorkflowRun) => {
      saved.push(run.id);
      return Promise.resolve();
    },
  } as unknown as DoctorRunRepository;
  return { runRepo, saved };
}

/** An output repository holding no method-run records. */
const noOutputs: MethodRunOutputs = {
  findByIds: () => Promise.resolve(new Map()),
  save: () => Promise.reject(new Error("unexpected output save")),
};

/** Saves a step's method-run output `running` under `pid`, as a step does. */
async function saveRunningOutput(
  outputRepo: YamlOutputRepository,
  pid: number,
): Promise<ModelOutput> {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "execute",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "workflow",
    },
  });
  output.markRunning(pid);
  await outputRepo.save(ModelType.create("command/shell"), "execute", output);
  return output;
}

/** Workflow lookup that knows only workflow "wf". */
const workflowRepo = {
  findByName: (name: string) =>
    Promise.resolve(
      name === "wf" ? { id: WORKFLOW_ID, name } as unknown as Workflow : null,
    ),
} as Pick<WorkflowRepository, "findByName">;

Deno.test(
  "diagnoseLocalRuns: lists a dead local owner as stale before its heartbeat expires, and writes nothing without fix",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    const { runRepo, saved } = runRepoOf([run]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      false,
    );

    assertEquals(result.stale.map((r) => r.id), [run.id]);
    assertEquals(result.active, []);
    assertEquals(result.reaped, 0);
    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(result.orphanedReaped, 0);
    assertEquals(tracker.findById(run.id)?.status, "running");
    assertEquals(run.status, "running");
    assertEquals(saved, []);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix reaps the dead owner's tracker rows and interrupts its run record",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    const stepRowId = crypto.randomUUID();
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.register(trackerRow(stepRowId, DEAD_PID, "model_method"));
    const { runRepo, saved } = runRepoOf([run]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      true,
    );

    assertEquals(result.reaped, 2);
    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(result.orphanedReaped, 1);
    assertEquals(tracker.findById(run.id)?.status, "interrupted");
    assertEquals(tracker.findById(stepRowId)?.status, "interrupted");
    assertEquals(run.status, "interrupted");
    assertEquals(run.tags["interrupt_reason"], "owner_process_dead");
    assertEquals(
      run.jobs[0].steps.map((s) => s.status),
      ["succeeded", "unknown"],
    );
    assertEquals(saved, [run.id]);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix leaves a live owner, a remote owner and an untracked run alone",
  withTracker(async (tracker) => {
    const live = strandedRun(Deno.pid);
    const remote = strandedRun(DEAD_PID);
    const untracked = strandedRun(DEAD_PID);
    tracker.register(trackerRow(live.id, Deno.pid));
    tracker.register(
      trackerRow(remote.id, DEAD_PID, "workflow", "some-other-host"),
    );
    const { runRepo, saved } = runRepoOf([live, remote, untracked]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      true,
    );

    assertEquals(
      result.active.map((r) => r.id).sort(),
      [live.id, remote.id].sort(),
    );
    assertEquals(result.stale, []);
    assertEquals(result.orphanedWorkflowRuns, 0);
    assertEquals(live.status, "running");
    assertEquals(remote.status, "running");
    assertEquals(untracked.status, "running");
    assertEquals(saved, []);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix settles a run older than the scan window through its tracker row",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    const { runRepo, saved } = runRepoOf([run], []);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      true,
    );

    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(result.orphanedReaped, 1);
    assertEquals(run.status, "interrupted");
    assertEquals(saved, [run.id]);
  }),
);

Deno.test(
  "diagnoseLocalRuns: without fix, an old run is counted through its tracker row but not written",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.complete(run.id, "interrupted");
    const { runRepo, saved } = runRepoOf([run], []);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      false,
    );

    assertEquals(result.orphanedWorkflowRuns, 1);
    assertEquals(run.status, "running");
    assertEquals(saved, []);
  }),
);

/** Records every markSettled call on `tracker` as [id, reason]. */
function recordSettles(tracker: RunTrackerStore): [string, string][] {
  const marked: [string, string][] = [];
  const markSettled = tracker.markSettled.bind(tracker);
  tracker.markSettled = (id: string, reason: string) => {
    marked.push([id, reason]);
    markSettled(id, reason);
  };
  return marked;
}

Deno.test(
  "diagnoseLocalRuns: fix marks an interrupted row settled only once its record is no longer running",
  withTracker(async (tracker) => {
    const settled = strandedRun(DEAD_PID);
    settled.interrupt("server_crash");
    const remote = strandedRun(DEAD_PID);
    const renamed = strandedRun(DEAD_PID);
    renamed.interrupt("server_crash");
    const deleted = strandedRun(DEAD_PID);
    for (
      const [run, host] of [
        [settled, hostname()],
        [remote, "some-other-host"],
        [renamed, hostname()],
        [deleted, hostname()],
      ] as const
    ) {
      tracker.register(trackerRow(run.id, DEAD_PID, "workflow", host));
      tracker.complete(run.id, "interrupted");
    }
    // The renamed run's record is not under its row's workflow name, and
    // the deleted run has no record at all.
    const { runRepo, saved } = runRepoOf([settled, remote], [], [renamed]);
    const marked = recordSettles(tracker);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      true,
    );

    // The remote row's record is still running on another host.
    assertEquals(
      marked.sort(),
      ([
        [settled.id, "record_settled"],
        [renamed.id, "record_settled"],
        [deleted.id, "record_missing"],
      ] as [string, string][]).sort(),
    );
    assertEquals(result.orphanedWorkflowRuns, 0);
    assertEquals(remote.status, "running");
    assertEquals(saved, []);
  }),
);

Deno.test(
  "diagnoseLocalRuns: fix settles the running record of a renamed workflow's dead owner (swamp-club#2917)",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    const { runRepo, saved } = runRepoOf([], [], [run]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      true,
    );

    assertEquals(result.orphanedReaped, 1);
    assertEquals(run.status, "interrupted");
    assertEquals(saved, [run.id]);
    assertEquals(tracker.findById(run.id)?.settled, true);
  }),
);

Deno.test(
  "diagnoseLocalRuns: a settled row's record is not looked up again (swamp-club#2917)",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    run.interrupt("server_crash");
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.complete(run.id, "interrupted");
    tracker.markSettled(run.id, "record_settled");
    const { runRepo } = runRepoOf([run], []);
    const lookups: string[] = [];
    const findById = runRepo.findById.bind(runRepo);
    runRepo.findById = (wfId, runId) => {
      lookups.push(runId);
      return findById(wfId, runId);
    };

    for (const fix of [false, true]) {
      await diagnoseLocalRuns(
        tracker,
        runRepo,
        workflowRepo,
        noOutputs,
        localOwnerLiveness(),
        fix,
      );
    }

    assertEquals(lookups, []);
  }),
);

Deno.test(
  "diagnoseLocalRuns: a recent running record behind a settled row is still settled through the scan",
  withTracker(async (tracker) => {
    // The row was settled as missing before a pull brought the record back.
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.complete(run.id, "interrupted");
    tracker.markSettled(run.id, "record_missing");
    const { runRepo, saved } = runRepoOf([run]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      true,
    );

    assertEquals(result.orphanedReaped, 1);
    assertEquals(run.status, "interrupted");
    assertEquals(saved, [run.id]);
  }),
);

Deno.test(
  "diagnoseLocalRuns: counts a dead owner's running method run, and fix cancels it",
  withTracker(async (tracker, dir) => {
    const outputRepo = new YamlOutputRepository(dir);
    const run = strandedRun(DEAD_PID);
    const step = await saveRunningOutput(outputRepo, DEAD_PID);
    const live = await saveRunningOutput(outputRepo, Deno.pid);
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.register(trackerRow(step.id, DEAD_PID, "model_method"));
    tracker.register(trackerRow(live.id, Deno.pid, "model_method"));
    const { runRepo } = runRepoOf([run]);
    const type = ModelType.create("command/shell");

    const report = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      outputRepo,
      localOwnerLiveness(),
      false,
    );
    assertEquals(report.orphanedMethodRuns, 1);
    assertEquals(report.orphanedMethodReaped, 0);
    assertEquals(
      (await outputRepo.findById(type, "execute", step.id))?.status,
      "running",
    );

    const fixed = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      outputRepo,
      localOwnerLiveness(),
      true,
    );
    assertEquals(fixed.orphanedMethodRuns, 1);
    assertEquals(fixed.orphanedMethodReaped, 1);
    const settled = await outputRepo.findById(type, "execute", step.id);
    assertEquals(settled?.status, "cancelled");
    assertEquals(settled?.completedAt !== undefined, true);
    assertEquals(tracker.findById(step.id)?.status, "interrupted");
    assertEquals(
      (await outputRepo.findById(type, "execute", live.id))?.status,
      "running",
    );
    assertEquals(tracker.findById(live.id)?.status, "running");
    assertEquals(run.status, "interrupted");
  }),
);

Deno.test(
  "diagnoseLocalRuns: an unreadable method-run record is reported and the workflow pass still runs",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    tracker.register(
      trackerRow(crypto.randomUUID(), DEAD_PID, "model_method"),
    );
    const { runRepo, saved } = runRepoOf([run]);

    const result = await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      {
        findByIds: () => Promise.reject(new Error("permission denied")),
        save: () => Promise.reject(new Error("unexpected output save")),
      },
      localOwnerLiveness(),
      true,
    );

    assertEquals(result.orphanedMethodError, "permission denied");
    assertEquals(result.orphanedMethodRuns, 0);
    assertEquals(result.orphanedReaped, 1);
    assertEquals(run.status, "interrupted");
    assertEquals(saved, [run.id]);
  }),
);

Deno.test(
  "diagnoseLocalRuns: verifies the run index before looking for running records (swamp-club#2518)",
  withTracker(async (tracker) => {
    const run = strandedRun(DEAD_PID);
    tracker.register(trackerRow(run.id, DEAD_PID));
    const { runRepo } = runRepoOf([run]);
    const calls: string[] = [];
    const scan = runRepo.findGlobalByStatus.bind(runRepo);
    runRepo.findGlobalByStatus = (status, since) => {
      calls.push("scan");
      return scan(status, since);
    };
    runRepo.verifyIndexes = () => {
      calls.push("verify");
      return Promise.resolve();
    };

    await diagnoseLocalRuns(
      tracker,
      runRepo,
      workflowRepo,
      noOutputs,
      localOwnerLiveness(),
      false,
    );

    assertEquals(calls, ["verify", "scan"]);
  }),
);
