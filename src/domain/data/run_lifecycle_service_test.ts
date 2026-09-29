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
import { DefaultRunLifecycleService } from "./run_lifecycle_service.ts";
import type {
  RunSnapshotInfo,
  RunSnapshotRepository,
  WorkflowRunRepository,
} from "../workflows/repositories.ts";
import type { OutputRepository } from "../models/repositories.ts";

function createMockWorkflowRunRepo(
  result: {
    deleted: number;
    bytesReclaimed: number;
    deletedRunIds?: string[];
  } = {
    deleted: 0,
    bytesReclaimed: 0,
  },
): WorkflowRunRepository & { lastCutoff?: Date; lastDryRun?: boolean } {
  const mock = {
    lastCutoff: undefined as Date | undefined,
    lastDryRun: undefined as boolean | undefined,
    findById: () => Promise.resolve(null),
    findAllByWorkflowId: () => Promise.resolve([]),
    findLatestByWorkflowId: () => Promise.resolve(null),
    findAllGlobal: () => Promise.resolve([]),
    findAllGlobalSince: () => Promise.resolve([]),
    findGlobalByStatus: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    nextId: () => "mock-id" as ReturnType<WorkflowRunRepository["nextId"]>,
    getPath: () => "",
    deleteAllByWorkflowId: () => Promise.resolve(0),
    deleteOlderThan: (cutoff: Date, options?: { dryRun?: boolean }) => {
      mock.lastCutoff = cutoff;
      mock.lastDryRun = options?.dryRun;
      return Promise.resolve(result);
    },
  };
  return mock;
}

function createMockOutputRepo(
  result: { deleted: number; bytesReclaimed: number } = {
    deleted: 0,
    bytesReclaimed: 0,
  },
): OutputRepository & { lastCutoff?: Date; lastDryRun?: boolean } {
  const mock = {
    lastCutoff: undefined as Date | undefined,
    lastDryRun: undefined as boolean | undefined,
    findById: () => Promise.resolve(null),
    findByDefinition: () => Promise.resolve([]),
    findLatestByDefinition: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    findAllGlobal: () => Promise.resolve([]),
    findAllGlobalSince: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    deleteOlderThan: (cutoff: Date, options?: { dryRun?: boolean }) => {
      mock.lastCutoff = cutoff;
      mock.lastDryRun = options?.dryRun;
      return Promise.resolve(result);
    },
    deleteByMethodLifetime: (
      fallbackCutoff: Date,
      options?: { dryRun?: boolean },
    ) => {
      mock.lastCutoff = fallbackCutoff;
      mock.lastDryRun = options?.dryRun;
      return Promise.resolve(result);
    },
    nextId: () => "mock-id" as ReturnType<OutputRepository["nextId"]>,
    getPath: () => "",
  };
  return mock;
}

function createMockSnapshotRepo(
  snapshots: RunSnapshotInfo[] = [],
): RunSnapshotRepository & { deletedRunIds: string[] } {
  const mock = {
    deletedRunIds: [] as string[],
    listRunSnapshots: () =>
      Promise.resolve(
        snapshots.filter((s) => !mock.deletedRunIds.includes(s.runId)),
      ),
    deleteForRun: (runId: string) => {
      mock.deletedRunIds.push(runId);
      return Promise.resolve();
    },
  };
  return mock;
}

Deno.test("gcAll: delegates to both repos with correct cutoffs", async () => {
  const workflowRunRepo = createMockWorkflowRunRepo({
    deleted: 5,
    bytesReclaimed: 1000,
  });
  const outputRepo = createMockOutputRepo({
    deleted: 3,
    bytesReclaimed: 500,
  });
  const service = new DefaultRunLifecycleService(
    workflowRunRepo,
    outputRepo,
    createMockSnapshotRepo(),
    () => Promise.resolve(new Set()),
  );

  const result = await service.gcAll({
    workflowRunRetentionDays: 7,
    outputRetentionDays: 14,
    dryRun: false,
  });

  assertEquals(result.workflowRunsDeleted, 5);
  assertEquals(result.workflowRunBytesReclaimed, 1000);
  assertEquals(result.outputsDeleted, 3);
  assertEquals(result.outputBytesReclaimed, 500);
  assertEquals(result.dryRun, false);
  assertEquals(workflowRunRepo.lastDryRun, false);
  assertEquals(outputRepo.lastDryRun, false);
});

Deno.test("gcAll: passes dryRun flag through to repos", async () => {
  const workflowRunRepo = createMockWorkflowRunRepo();
  const outputRepo = createMockOutputRepo();
  const service = new DefaultRunLifecycleService(
    workflowRunRepo,
    outputRepo,
    createMockSnapshotRepo(),
    () => Promise.resolve(new Set()),
  );

  await service.gcAll({
    workflowRunRetentionDays: 30,
    outputRetentionDays: 30,
    dryRun: true,
  });

  assertEquals(workflowRunRepo.lastDryRun, true);
  assertEquals(outputRepo.lastDryRun, true);
});

Deno.test("gcAll: computes cutoff correctly from retention days", async () => {
  const workflowRunRepo = createMockWorkflowRunRepo();
  const outputRepo = createMockOutputRepo();
  const service = new DefaultRunLifecycleService(
    workflowRunRepo,
    outputRepo,
    createMockSnapshotRepo(),
    () => Promise.resolve(new Set()),
  );

  const before = Date.now();
  await service.gcAll({
    workflowRunRetentionDays: 7,
    outputRetentionDays: 14,
    dryRun: true,
  });
  const _after = Date.now();

  const wfCutoff = workflowRunRepo.lastCutoff!.getTime();
  const outCutoff = outputRepo.lastCutoff!.getTime();

  const expectedWfCutoff = before - 7 * 86_400_000;
  const expectedOutCutoff = before - 14 * 86_400_000;

  // Allow 100ms tolerance for test execution time
  assertEquals(Math.abs(wfCutoff - expectedWfCutoff) < 100, true);
  assertEquals(Math.abs(outCutoff - expectedOutCutoff) < 100, true);
  assertEquals(wfCutoff > outCutoff, true);
});

Deno.test("gcWorkflowRuns: calls repo with correct parameters", async () => {
  const workflowRunRepo = createMockWorkflowRunRepo({
    deleted: 10,
    bytesReclaimed: 2048,
  });
  const outputRepo = createMockOutputRepo();
  const service = new DefaultRunLifecycleService(
    workflowRunRepo,
    outputRepo,
    createMockSnapshotRepo(),
    () => Promise.resolve(new Set()),
  );

  const result = await service.gcWorkflowRuns({
    retentionDays: 3,
    dryRun: true,
  });

  assertEquals(result.deleted, 10);
  assertEquals(result.bytesReclaimed, 2048);
  assertEquals(workflowRunRepo.lastDryRun, true);
});

Deno.test("gcOutputs: calls repo with correct parameters", async () => {
  const workflowRunRepo = createMockWorkflowRunRepo();
  const outputRepo = createMockOutputRepo({
    deleted: 7,
    bytesReclaimed: 4096,
  });
  const service = new DefaultRunLifecycleService(
    workflowRunRepo,
    outputRepo,
    createMockSnapshotRepo(),
    () => Promise.resolve(new Set()),
  );

  const result = await service.gcOutputs({
    retentionDays: 1,
    dryRun: false,
  });

  assertEquals(result.deleted, 7);
  assertEquals(result.bytesReclaimed, 4096);
  assertEquals(outputRepo.lastDryRun, false);
});

const DAY_MS = 86_400_000;

function snapshot(runId: string, ageDays: number): RunSnapshotInfo {
  return {
    runId,
    modifiedAt: new Date(Date.now() - ageDays * DAY_MS),
    sizeBytes: 100,
  };
}

Deno.test("gcRunSnapshots: collects snapshots of collected runs and old orphans, keeps fresh orphans and live runs", async () => {
  const snapshotRepo = createMockSnapshotRepo([
    snapshot("collected", 40),
    snapshot("old-orphan", 40),
    snapshot("fresh-orphan", 0),
    snapshot("old-live-run", 40),
    snapshot("fresh-live-run", 0),
  ]);
  const service = new DefaultRunLifecycleService(
    createMockWorkflowRunRepo(),
    createMockOutputRepo(),
    snapshotRepo,
    () => Promise.resolve(new Set(["old-live-run", "fresh-live-run"])),
  );

  const result = await service.gcRunSnapshots({
    retentionDays: 30,
    deletedRunIds: ["collected"],
    dryRun: false,
  });

  assertEquals(result, { deleted: 2, bytesReclaimed: 200 });
  assertEquals(snapshotRepo.deletedRunIds.sort(), ["collected", "old-orphan"]);
});

Deno.test("gcRunSnapshots: collects a snapshot of a collected run even when it is newer than the cutoff", async () => {
  const snapshotRepo = createMockSnapshotRepo([snapshot("collected", 0)]);
  const service = new DefaultRunLifecycleService(
    createMockWorkflowRunRepo(),
    createMockOutputRepo(),
    snapshotRepo,
    // On a dry run the collected run's record still exists.
    () => Promise.resolve(new Set(["collected"])),
  );

  const result = await service.gcRunSnapshots({
    retentionDays: 30,
    deletedRunIds: ["collected"],
    dryRun: false,
  });

  assertEquals(result.deleted, 1);
  assertEquals(snapshotRepo.deletedRunIds, ["collected"]);
});

Deno.test("gcAll: dry run counts snapshots without deleting them", async () => {
  const snapshotRepo = createMockSnapshotRepo([
    snapshot("collected", 40),
    snapshot("old-orphan", 40),
  ]);
  const service = new DefaultRunLifecycleService(
    createMockWorkflowRunRepo({
      deleted: 1,
      bytesReclaimed: 10,
      deletedRunIds: ["collected"],
    }),
    createMockOutputRepo(),
    snapshotRepo,
    () => Promise.resolve(new Set(["collected"])),
  );

  const result = await service.gcAll({
    workflowRunRetentionDays: 30,
    outputRetentionDays: 30,
    dryRun: true,
  });

  assertEquals(result.snapshotsDeleted, 2);
  assertEquals(result.snapshotBytesReclaimed, 200);
  assertEquals(snapshotRepo.deletedRunIds, []);
});

Deno.test("gcAll: passes the collected run IDs to the snapshot pass", async () => {
  const snapshotRepo = createMockSnapshotRepo([snapshot("collected", 0)]);
  const service = new DefaultRunLifecycleService(
    createMockWorkflowRunRepo({
      deleted: 1,
      bytesReclaimed: 10,
      deletedRunIds: ["collected"],
    }),
    createMockOutputRepo(),
    snapshotRepo,
    () => Promise.resolve(new Set()),
  );

  const result = await service.gcAll({
    workflowRunRetentionDays: 30,
    outputRetentionDays: 30,
    dryRun: false,
  });

  assertEquals(result.snapshotsDeleted, 1);
  assertEquals(snapshotRepo.deletedRunIds, ["collected"]);
});

Deno.test("gcRunSnapshots: never sweeps an orphan younger than the minimum age, even with a tiny retention", async () => {
  const snapshotRepo = createMockSnapshotRepo([
    {
      runId: "starting",
      modifiedAt: new Date(Date.now() - 60_000),
      sizeBytes: 1,
    },
    {
      runId: "old",
      modifiedAt: new Date(Date.now() - 2 * 3_600_000),
      sizeBytes: 1,
    },
  ]);
  const service = new DefaultRunLifecycleService(
    createMockWorkflowRunRepo(),
    createMockOutputRepo(),
    snapshotRepo,
    () => Promise.resolve(new Set()),
  );

  // Retention of about 1 second: the starting run's snapshot is older than
  // that, but younger than the one-hour minimum orphan age.
  await service.gcRunSnapshots({
    retentionDays: 1 / 86_400,
    deletedRunIds: [],
    dryRun: false,
  });

  assertEquals(snapshotRepo.deletedRunIds, ["old"]);
});

Deno.test("gcAll: a failing snapshot pass still reports the runs collected", async () => {
  const service = new DefaultRunLifecycleService(
    createMockWorkflowRunRepo({
      deleted: 2,
      bytesReclaimed: 20,
      deletedRunIds: ["a", "b"],
    }),
    createMockOutputRepo(),
    {
      listRunSnapshots: () => Promise.reject(new Error("permission denied")),
      deleteForRun: () => Promise.resolve(),
    },
    () => Promise.resolve(new Set()),
  );

  const result = await service.gcAll({
    workflowRunRetentionDays: 30,
    outputRetentionDays: 30,
    dryRun: false,
  });

  assertEquals(result.workflowRunsDeleted, 2);
  assertEquals(result.snapshotsDeleted, 0);
});
