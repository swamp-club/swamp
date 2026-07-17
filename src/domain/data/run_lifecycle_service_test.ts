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
import type { WorkflowRunRepository } from "../workflows/repositories.ts";
import type { OutputRepository } from "../models/repositories.ts";

function createMockWorkflowRunRepo(
  result: { deleted: number; bytesReclaimed: number } = {
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
    nextId: () => "mock-id" as ReturnType<OutputRepository["nextId"]>,
    getPath: () => "",
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
  const service = new DefaultRunLifecycleService(workflowRunRepo, outputRepo);

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
  const service = new DefaultRunLifecycleService(workflowRunRepo, outputRepo);

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
  const service = new DefaultRunLifecycleService(workflowRunRepo, outputRepo);

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
  const service = new DefaultRunLifecycleService(workflowRunRepo, outputRepo);

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
  const service = new DefaultRunLifecycleService(workflowRunRepo, outputRepo);

  const result = await service.gcOutputs({
    retentionDays: 1,
    dryRun: false,
  });

  assertEquals(result.deleted, 7);
  assertEquals(result.bytesReclaimed, 4096);
  assertEquals(outputRepo.lastDryRun, false);
});
