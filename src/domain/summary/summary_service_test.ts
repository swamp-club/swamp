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
import { SummaryService } from "./summary_service.ts";
import { ModelOutput } from "../models/model_output.ts";
import { ModelType } from "../models/model_type.ts";
import { WorkflowRun } from "../workflows/workflow_run.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import { createWorkflowId } from "../workflows/workflow_id.ts";
import type { OutputRepository } from "../models/repositories.ts";
import type { WorkflowRunRepository } from "../workflows/repositories.ts";
import type { DataRepositoryReader } from "./summary_types.ts";
import { Data } from "../data/data.ts";

// ── Helpers ─────────────────────────────────────────────────────────

function makeOutput(
  opts: {
    definitionId?: string;
    status?: "succeeded" | "failed";
    startedAt?: Date;
    methodName?: string;
    triggeredBy?: "manual" | "workflow";
    durationMs?: number;
    error?: string;
  } = {},
): ModelOutput {
  const defId = createDefinitionId(opts.definitionId ?? crypto.randomUUID());
  const output = ModelOutput.create({
    definitionId: defId,
    methodName: opts.methodName ?? "apply",
    status: "running",
    startedAt: opts.startedAt ?? new Date(),
    provenance: {
      definitionHash: "abc123",
      modelVersion: "1",
      triggeredBy: opts.triggeredBy ?? "manual",
    },
  });
  if (opts.status === "succeeded") {
    output.markSucceeded();
  } else if (opts.status === "failed") {
    output.markFailed({ message: opts.error ?? "some error" });
  }
  return output;
}

function makeWorkflowRun(
  opts: {
    name?: string;
    status?: "succeeded" | "failed";
    startedAt?: Date;
    failedStep?: string;
  } = {},
): WorkflowRun {
  const data = {
    id: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    workflowName: opts.name ?? "deploy",
    status: opts.status ?? "succeeded" as const,
    startedAt: (opts.startedAt ?? new Date()).toISOString(),
    completedAt: new Date().toISOString(),
    jobs: opts.failedStep
      ? [{
        jobName: "job1",
        status: "failed" as const,
        steps: [
          {
            stepName: opts.failedStep,
            status: "failed" as const,
            error: "step failed",
          },
        ],
      }]
      : [{
        jobName: "job1",
        status: "succeeded" as const,
        steps: [{
          stepName: "step1",
          status: "succeeded" as const,
        }],
      }],
    tags: {},
  };
  return WorkflowRun.fromData(data);
}

function makeData(
  opts: { createdAt?: Date; version?: number } = {},
): Data {
  return Data.create({
    name: `data-${crypto.randomUUID().slice(0, 8)}`,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    version: opts.version,
    tags: { type: "output" },
    ownerDefinition: {
      ownerType: "manual",
      ownerRef: "test",
    },
    createdAt: opts.createdAt,
  });
}

// ── Mock repos ──────────────────────────────────────────────────────

function createMockOutputRepo(
  items: { output: ModelOutput; type: ModelType; method: string }[],
): OutputRepository {
  return {
    findAllGlobal: () => Promise.resolve(items),
    findAllGlobalSince: (cutoff: Date) =>
      Promise.resolve(items.filter(({ output }) => output.startedAt >= cutoff)),
    findById: () => Promise.resolve(null),
    findByDefinition: () => Promise.resolve([]),
    findLatestByDefinition: () => Promise.resolve(null),
    findAll: () => Promise.resolve([]),
    save: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    nextId: () => "mock-id" as ReturnType<OutputRepository["nextId"]>,
    getPath: () => "",
  };
}

function createMockWorkflowRunRepo(
  items: Awaited<ReturnType<WorkflowRunRepository["findAllGlobal"]>>,
): WorkflowRunRepository {
  return {
    findAllGlobal: () => Promise.resolve(items),
    findAllGlobalSince: (cutoff: Date) =>
      Promise.resolve(
        items.filter(({ run }) =>
          run.startedAt !== undefined && run.startedAt >= cutoff
        ),
      ),
    findById: () => Promise.resolve(null),
    findAllByWorkflowId: () => Promise.resolve([]),
    findLatestByWorkflowId: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    nextId: () => "mock-id" as ReturnType<WorkflowRunRepository["nextId"]>,
    getPath: () => "",
    deleteAllByWorkflowId: () => Promise.resolve(0),
  };
}

function createMockDataRepo(
  items: Awaited<ReturnType<DataRepositoryReader["findAllGlobal"]>>,
): DataRepositoryReader {
  return {
    findAllGlobal: () => Promise.resolve(items),
    findAllGlobalSince: (cutoff: Date) =>
      Promise.resolve(items.filter(({ data }) => data.createdAt >= cutoff)),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

Deno.test("summarise - empty repos return zero counts", async () => {
  const service = new SummaryService(
    createMockOutputRepo([]),
    createMockWorkflowRunRepo([]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0));

  assertEquals(result.methodExecutions.length, 0);
  assertEquals(result.workflows.length, 0);
  assertEquals(result.data.totalItems, 0);
  assertEquals(result.data.totalVersions, 0);
  assertEquals(result.data.uniqueModels, 0);
});

Deno.test("summarise - filters by cutoff date", async () => {
  const cutoff = new Date("2026-03-01T00:00:00Z");
  const before = new Date("2026-02-28T00:00:00Z");
  const after = new Date("2026-03-02T00:00:00Z");

  const type = ModelType.create("aws/s3-bucket");
  const service = new SummaryService(
    createMockOutputRepo([
      {
        output: makeOutput({ status: "succeeded", startedAt: before }),
        type,
        method: "apply",
      },
      {
        output: makeOutput({ status: "succeeded", startedAt: after }),
        type,
        method: "apply",
      },
    ]),
    createMockWorkflowRunRepo([
      {
        run: makeWorkflowRun({ startedAt: before }),
        workflowId: createWorkflowId(crypto.randomUUID()),
      },
      {
        run: makeWorkflowRun({ startedAt: after }),
        workflowId: createWorkflowId(crypto.randomUUID()),
      },
    ]),
    createMockDataRepo([
      { data: makeData({ createdAt: before }), modelType: type, modelId: "m1" },
      { data: makeData({ createdAt: after }), modelType: type, modelId: "m1" },
    ]),
  );

  const result = await service.summarise(cutoff);

  assertEquals(result.methodExecutions.length, 1);
  assertEquals(result.methodExecutions[0].total, 1);
  assertEquals(result.workflows.length, 1);
  assertEquals(result.workflows[0].total, 1);
  assertEquals(result.data.totalItems, 1);
});

Deno.test("summarise - groups method executions by model", async () => {
  const type1 = ModelType.create("aws/s3-bucket");
  const defId1 = crypto.randomUUID();
  const defId2 = crypto.randomUUID();

  const service = new SummaryService(
    createMockOutputRepo([
      {
        output: makeOutput({ definitionId: defId1, status: "succeeded" }),
        type: type1,
        method: "apply",
      },
      {
        output: makeOutput({ definitionId: defId1, status: "failed" }),
        type: type1,
        method: "apply",
      },
      {
        output: makeOutput({ definitionId: defId2, status: "succeeded" }),
        type: type1,
        method: "apply",
      },
    ]),
    createMockWorkflowRunRepo([]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0));

  // Two models (by definitionId), first has most runs
  assertEquals(result.methodExecutions.length, 2);
  assertEquals(result.methodExecutions[0].total, 2);
  assertEquals(result.methodExecutions[0].succeeded, 1);
  assertEquals(result.methodExecutions[0].failed, 1);
  assertEquals(result.methodExecutions[0].methods.length, 1);
  assertEquals(result.methodExecutions[0].methods[0].method, "apply");
  assertEquals(result.methodExecutions[1].total, 1);
});

Deno.test("summarise - sorts models by total descending", async () => {
  const type = ModelType.create("aws/s3-bucket");
  const defIdFew = crypto.randomUUID();
  const defIdMany = crypto.randomUUID();

  const service = new SummaryService(
    createMockOutputRepo([
      {
        output: makeOutput({ definitionId: defIdFew, status: "succeeded" }),
        type,
        method: "apply",
      },
      {
        output: makeOutput({ definitionId: defIdMany, status: "succeeded" }),
        type,
        method: "apply",
      },
      {
        output: makeOutput({ definitionId: defIdMany, status: "succeeded" }),
        type,
        method: "apply",
      },
      {
        output: makeOutput({ definitionId: defIdMany, status: "succeeded" }),
        type,
        method: "apply",
      },
    ]),
    createMockWorkflowRunRepo([]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0));

  assertEquals(result.methodExecutions[0].modelName, defIdMany);
  assertEquals(result.methodExecutions[0].total, 3);
  assertEquals(result.methodExecutions[1].modelName, defIdFew);
  assertEquals(result.methodExecutions[1].total, 1);
});

Deno.test("summarise - groups workflow runs by name", async () => {
  const service = new SummaryService(
    createMockOutputRepo([]),
    createMockWorkflowRunRepo([
      {
        run: makeWorkflowRun({ name: "deploy", status: "succeeded" }),
        workflowId: createWorkflowId(crypto.randomUUID()),
      },
      {
        run: makeWorkflowRun({
          name: "deploy",
          status: "failed",
          failedStep: "build",
        }),
        workflowId: createWorkflowId(crypto.randomUUID()),
      },
      {
        run: makeWorkflowRun({ name: "backup", status: "succeeded" }),
        workflowId: createWorkflowId(crypto.randomUUID()),
      },
    ]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0));

  assertEquals(result.workflows.length, 2);
  assertEquals(result.workflows[0].workflowName, "deploy");
  assertEquals(result.workflows[0].total, 2);
  assertEquals(result.workflows[0].succeeded, 1);
  assertEquals(result.workflows[0].failed, 1);
  assertEquals(result.workflows[1].workflowName, "backup");
  assertEquals(result.workflows[1].total, 1);
});

Deno.test("summarise - populates verbose run details", async () => {
  const type = ModelType.create("aws/s3-bucket");
  const startedAt = new Date("2026-03-02T10:00:00Z");

  const service = new SummaryService(
    createMockOutputRepo([
      {
        output: makeOutput({
          status: "failed",
          startedAt,
          triggeredBy: "workflow",
          error: "AccessDenied",
        }),
        type,
        method: "apply",
      },
    ]),
    createMockWorkflowRunRepo([]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0));

  assertEquals(result.methodExecutions[0].methods.length, 1);
  assertEquals(result.methodExecutions[0].methods[0].runs.length, 1);
  const run = result.methodExecutions[0].methods[0].runs[0];
  assertEquals(run.status, "failed");
  assertEquals(run.triggeredBy, "workflow");
  assertEquals(run.error, "AccessDenied");
});

Deno.test("summarise - extracts first failed step from workflow runs", async () => {
  const service = new SummaryService(
    createMockOutputRepo([]),
    createMockWorkflowRunRepo([
      {
        run: makeWorkflowRun({
          name: "deploy",
          status: "failed",
          failedStep: "build",
        }),
        workflowId: createWorkflowId(crypto.randomUUID()),
      },
    ]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0));

  assertEquals(result.workflows[0].runs[0].firstFailedStep, "build");
});

Deno.test("summarise - counts data items, versions, and unique models", async () => {
  const type1 = ModelType.create("aws/s3-bucket");
  const type2 = ModelType.create("aws/ec2-instance");

  const service = new SummaryService(
    createMockOutputRepo([]),
    createMockWorkflowRunRepo([]),
    createMockDataRepo([
      // version 3 means 3 versions exist for this item
      { data: makeData({ version: 3 }), modelType: type1, modelId: "m1" },
      { data: makeData({ version: 1 }), modelType: type1, modelId: "m1" },
      { data: makeData({ version: 5 }), modelType: type2, modelId: "m2" },
    ]),
  );

  const result = await service.summarise(new Date(0));

  assertEquals(result.data.totalItems, 3);
  assertEquals(result.data.totalVersions, 9); // 3 + 1 + 5
  assertEquals(result.data.uniqueModels, 2);

  // Model type breakdown
  assertEquals(result.data.byModelType.length, 2);
  assertEquals(result.data.byModelType[0].modelType, "aws/s3-bucket");
  assertEquals(result.data.byModelType[0].items, 2);
  assertEquals(result.data.byModelType[0].versions, 4); // 3 + 1
  assertEquals(result.data.byModelType[1].modelType, "aws/ec2-instance");
  assertEquals(result.data.byModelType[1].items, 1);
  assertEquals(result.data.byModelType[1].versions, 5);
});

Deno.test("summarise - limit truncates per-group runs but counts reflect all matching runs", async () => {
  const type = ModelType.create("aws/s3-bucket");
  const wfId = createWorkflowId(crypto.randomUUID());
  const sharedDefId = crypto.randomUUID();

  const outputs = Array.from({ length: 10 }, (_, i) => ({
    output: makeOutput({
      definitionId: sharedDefId,
      status: i % 2 === 0 ? "succeeded" : "failed",
      startedAt: new Date(2026, 0, 1, 0, i),
    }),
    type,
    method: "apply",
  }));

  const runs = Array.from({ length: 8 }, (_, i) => ({
    run: makeWorkflowRun({
      status: "succeeded",
      startedAt: new Date(2026, 0, 1, 0, i),
    }),
    workflowId: wfId,
  }));

  const service = new SummaryService(
    createMockOutputRepo(outputs),
    createMockWorkflowRunRepo(runs),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0), { limit: 3 });

  // Method group: counts reflect all 10, runs[] is capped at 3, truncated set
  assertEquals(result.methodExecutions.length, 1);
  const methodGroup = result.methodExecutions[0].methods[0];
  assertEquals(methodGroup.total, 10);
  assertEquals(methodGroup.succeeded, 5);
  assertEquals(methodGroup.failed, 5);
  assertEquals(methodGroup.runs.length, 3);
  assertEquals(methodGroup.truncated, true);

  // Workflow group: counts reflect all 8, runs[] is capped at 3, truncated set
  assertEquals(result.workflows.length, 1);
  const wfGroup = result.workflows[0];
  assertEquals(wfGroup.total, 8);
  assertEquals(wfGroup.succeeded, 8);
  assertEquals(wfGroup.runs.length, 3);
  assertEquals(wfGroup.truncated, true);
});

Deno.test("summarise - omits truncated when limit is not exceeded", async () => {
  const type = ModelType.create("aws/s3-bucket");
  const service = new SummaryService(
    createMockOutputRepo([
      {
        output: makeOutput({ status: "succeeded" }),
        type,
        method: "apply",
      },
      {
        output: makeOutput({ status: "succeeded" }),
        type,
        method: "apply",
      },
    ]),
    createMockWorkflowRunRepo([
      {
        run: makeWorkflowRun({ status: "succeeded" }),
        workflowId: createWorkflowId(crypto.randomUUID()),
      },
    ]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0), { limit: 100 });

  assertEquals(
    result.methodExecutions[0].methods[0].truncated,
    undefined,
    "truncated should be omitted when no truncation occurred",
  );
  assertEquals(
    result.workflows[0].truncated,
    undefined,
    "truncated should be omitted when no truncation occurred",
  );
});

Deno.test("summarise - default (no limit) preserves all runs in details", async () => {
  const type = ModelType.create("aws/s3-bucket");
  const sharedDefId = crypto.randomUUID();
  const service = new SummaryService(
    createMockOutputRepo(
      Array.from({ length: 50 }, () => ({
        output: makeOutput({
          definitionId: sharedDefId,
          status: "succeeded",
        }),
        type,
        method: "apply",
      })),
    ),
    createMockWorkflowRunRepo([]),
    createMockDataRepo([]),
  );

  const result = await service.summarise(new Date(0));

  assertEquals(result.methodExecutions[0].methods[0].runs.length, 50);
  assertEquals(result.methodExecutions[0].methods[0].truncated, undefined);
});
