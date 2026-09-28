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
import { WorkflowDataService } from "./workflow_data_service.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import { WorkflowRun } from "../workflows/workflow_run.ts";
import type { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { computeDefinitionHash } from "../models/model_output.ts";
import {
  type createDefinitionId,
  Definition,
} from "../definitions/definition.ts";

// Import models barrel to trigger self-registration
import "../models/models.ts";

/**
 * Creates a test Data instance.
 */
async function createTestData(
  name: string,
  tags: Record<string, string> = { type: "resource" },
): Promise<Data> {
  const definitionHash = await computeDefinitionHash({
    type: "model-method",
    ref: "test:create",
  });
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags,
    ownerDefinition: {
      definitionHash,
      ownerType: "model-method",
      ownerRef: "test:create",
    },
  });
}

/**
 * Creates a mock FileSystemUnifiedDataRepository.
 */
function createMockDataRepo(
  globalData: Array<{ data: Data; modelType: ModelType; modelId: string }>,
  storedVersions: Array<
    { data: Data; modelType: ModelType; modelId: string }
  > = globalData,
): FileSystemUnifiedDataRepository {
  return {
    findAllGlobal: () => Promise.resolve(globalData),
    findByName: (
      type: ModelType,
      modelId: string,
      dataName: string,
      version?: number,
    ) => {
      const matches = storedVersions.filter((item) =>
        item.modelType.normalized === type.normalized &&
        item.modelId === modelId && item.data.name === dataName
      );
      if (version !== undefined) {
        return Promise.resolve(
          matches.find((item) => item.data.version === version)?.data ?? null,
        );
      }
      const latest = matches.sort((a, b) => b.data.version - a.data.version)[0];
      return Promise.resolve(latest?.data ?? null);
    },
    getContentPath: (
      type: ModelType,
      modelId: string,
      dataName: string,
      version: number,
    ) => `.swamp/data/${type.normalized}/${modelId}/${dataName}/${version}/raw`,
  } as unknown as FileSystemUnifiedDataRepository;
}

/**
 * Creates a mock YamlDefinitionRepository.
 */
function createMockDefinitionRepo(
  definitions: Map<string, Definition> = new Map(),
): YamlDefinitionRepository {
  return {
    findById: (_type: ModelType, id: ReturnType<typeof createDefinitionId>) => {
      return Promise.resolve(definitions.get(id as string) ?? null);
    },
  } as unknown as YamlDefinitionRepository;
}

const TEST_RUN_ID = "550e8400-e29b-41d4-a716-446655440001";
const TEST_WORKFLOW_ID = "550e8400-e29b-41d4-a716-446655440002";
const TEST_GC_DATA_ID = "550e8400-e29b-41d4-a716-446655440099";
const TEST_MODEL_ID = "550e8400-e29b-41d4-a716-446655440003";

/**
 * Creates a test workflow run with the given step data.
 */
function createTestRun(
  steps: Array<{
    stepName: string;
    artifacts: Array<
      {
        dataId: string;
        name: string;
        version: number;
        tags: Record<string, string>;
      }
    >;
  }>,
): WorkflowRun {
  return WorkflowRun.fromData({
    id: TEST_RUN_ID,
    workflowId: TEST_WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "succeeded",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    jobs: [{
      jobName: "main",
      status: "succeeded",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      steps: steps.map((s) => ({
        stepName: s.stepName,
        status: "succeeded",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        dataArtifacts: s.artifacts,
      })),
    }],
  });
}

Deno.test("WorkflowDataService.findAllForWorkflowRun returns data from run artifacts", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const data1 = await createTestData("vpc-state", {
    type: "resource",
    workflow: "test",
    step: "create",
  });
  const data2 = await createTestData("vpc-log", {
    type: "log",
    workflow: "test",
    step: "create",
  });

  const globalData = [
    { data: data1, modelType, modelId: TEST_MODEL_ID },
    { data: data2, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [
      {
        dataId: data1.id,
        name: "vpc-state",
        version: 1,
        tags: { type: "resource", workflow: "test", step: "create" },
      },
      {
        dataId: data2.id,
        name: "vpc-log",
        version: 1,
        tags: { type: "log", workflow: "test", step: "create" },
      },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 2);
  assertEquals(result[0].data.name, "vpc-state");
  assertEquals(result[1].data.name, "vpc-log");
  assertEquals(result[0].jobName, "main");
  assertEquals(result[0].stepName, "create");
});

Deno.test("WorkflowDataService.findAllForWorkflowRun skips GC'd data", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const data1 = await createTestData("vpc-state");

  // Only data1 exists in the repo; data2 (dataId "gc-removed") was GC'd
  const globalData = [
    { data: data1, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [
      {
        dataId: data1.id,
        name: "vpc-state",
        version: 1,
        tags: { type: "resource" },
      },
      {
        dataId: TEST_GC_DATA_ID,
        name: "deleted-data",
        version: 1,
        tags: { type: "data" },
      },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.name, "vpc-state");
});

Deno.test("WorkflowDataService.findAllForWorkflowRun returns empty for runs with no artifacts", async () => {
  const run = createTestRun([{
    stepName: "shell-step",
    artifacts: [],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo([]),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 0);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun resolves model names", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const data1 = await createTestData("vpc-state");

  const definitions = new Map<string, Definition>();
  definitions.set(
    TEST_MODEL_ID,
    Definition.fromData({
      id: TEST_MODEL_ID,
      name: "my-vpc",
      version: 1,
      tags: {},
      globalArguments: {},
      methods: {},
      inputs: undefined,
    }),
  );

  const globalData = [
    { data: data1, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [
      {
        dataId: data1.id,
        name: "vpc-state",
        version: 1,
        tags: { type: "resource" },
      },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(definitions),
    createMockDataRepo(globalData),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].modelName, "my-vpc");
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun finds data by name", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const data1 = await createTestData("vpc-state");
  const data2 = await createTestData("vpc-log");

  const globalData = [
    { data: data1, modelType, modelId: TEST_MODEL_ID },
    { data: data2, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [
      {
        dataId: data1.id,
        name: "vpc-state",
        version: 1,
        tags: { type: "resource" },
      },
      { dataId: data2.id, name: "vpc-log", version: 1, tags: { type: "log" } },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  const result = await service.findByNameInWorkflowRun(run, "vpc-state");
  assertEquals(result !== null, true);
  assertEquals(result!.data.name, "vpc-state");
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun returns null for non-existent name", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const data1 = await createTestData("vpc-state");

  const globalData = [
    { data: data1, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [
      {
        dataId: data1.id,
        name: "vpc-state",
        version: 1,
        tags: { type: "resource" },
      },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  const result = await service.findByNameInWorkflowRun(run, "nonexistent");
  assertEquals(result, null);
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: falls back to specName tag when instance name differs", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const data1 = await createTestData("classification-main", {
    type: "resource",
    specName: "classification",
  });

  const globalData = [
    { data: data1, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "classify",
    artifacts: [
      {
        dataId: data1.id,
        name: "classification-main",
        version: 1,
        tags: { type: "resource", specName: "classification" },
      },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  // Querying by spec name should resolve via fallback
  const result = await service.findByNameInWorkflowRun(run, "classification");
  assertEquals(result !== null, true);
  assertEquals(result!.data.name, "classification-main");
  assertEquals(result!.stepName, "classify");
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: exact name match takes priority over specName", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const exactMatch = await createTestData("classification", {
    type: "resource",
    specName: "something-else",
  });
  const specMatch = await createTestData("classification-main", {
    type: "resource",
    specName: "classification",
  });

  const globalData = [
    { data: exactMatch, modelType, modelId: TEST_MODEL_ID },
    { data: specMatch, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "step1",
    artifacts: [
      {
        dataId: exactMatch.id,
        name: "classification",
        version: 1,
        tags: { type: "resource", specName: "something-else" },
      },
      {
        dataId: specMatch.id,
        name: "classification-main",
        version: 1,
        tags: { type: "resource", specName: "classification" },
      },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  // Exact name match should win over specName fallback
  const result = await service.findByNameInWorkflowRun(run, "classification");
  assertEquals(result !== null, true);
  assertEquals(result!.data.name, "classification");
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: specName fallback skips data without specName tag", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const data1 = await createTestData("some-data", {
    type: "resource",
  });

  const globalData = [
    { data: data1, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "step1",
    artifacts: [
      {
        dataId: data1.id,
        name: "some-data",
        version: 1,
        tags: { type: "resource" },
      },
    ],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  // No specName tag on the data, so fallback should not match
  const result = await service.findByNameInWorkflowRun(run, "nonexistent");
  assertEquals(result, null);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun resolves workflow-scope artifacts", async () => {
  const workflowModelType = ModelType.create("workflow");
  const wfReportData = await createTestData("report-swamp-workflow-summary", {
    type: "report",
    reportName: "@swamp/workflow-summary",
    reportScope: "workflow",
  });

  const globalData = [
    {
      data: wfReportData,
      modelType: workflowModelType,
      modelId: TEST_WORKFLOW_ID,
    },
  ];

  const run = WorkflowRun.fromData({
    id: TEST_RUN_ID,
    workflowId: TEST_WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "succeeded",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    jobs: [{
      jobName: "main",
      status: "succeeded",
      steps: [{ stepName: "noop", status: "succeeded" }],
    }],
    workflowDataArtifacts: [{
      dataId: wfReportData.id,
      name: "report-swamp-workflow-summary",
      version: 1,
      tags: {
        type: "report",
        reportName: "@swamp/workflow-summary",
        reportScope: "workflow",
      },
    }],
  });

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.name, "report-swamp-workflow-summary");
  assertEquals(result[0].modelType.normalized, "workflow");
  // Workflow-scope items have no owning job or step.
  assertEquals(result[0].jobName, undefined);
  assertEquals(result[0].stepName, undefined);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun returns both step and workflow-scope artifacts", async () => {
  const stepModelType = ModelType.create("aws/ec2/vpc");
  const stepData = await createTestData("vpc-state");
  const wfModelType = ModelType.create("workflow");
  const wfReportData = await createTestData("report-swamp-workflow-summary", {
    type: "report",
    reportScope: "workflow",
  });

  const globalData = [
    { data: stepData, modelType: stepModelType, modelId: TEST_MODEL_ID },
    {
      data: wfReportData,
      modelType: wfModelType,
      modelId: TEST_WORKFLOW_ID,
    },
  ];

  const run = WorkflowRun.fromData({
    id: TEST_RUN_ID,
    workflowId: TEST_WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "succeeded",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    jobs: [{
      jobName: "main",
      status: "succeeded",
      steps: [{
        stepName: "create",
        status: "succeeded",
        dataArtifacts: [{
          dataId: stepData.id,
          name: "vpc-state",
          version: 1,
          tags: { type: "resource" },
        }],
      }],
    }],
    workflowDataArtifacts: [{
      dataId: wfReportData.id,
      name: "report-swamp-workflow-summary",
      version: 1,
      tags: { type: "report", reportScope: "workflow" },
    }],
  });

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(globalData),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 2);

  const stepItem = result.find((r) => r.data.name === "vpc-state");
  if (!stepItem) throw new Error("expected step artifact");
  assertEquals(stepItem.jobName, "main");
  assertEquals(stepItem.stepName, "create");

  const wfItem = result.find((r) =>
    r.data.name === "report-swamp-workflow-summary"
  );
  if (!wfItem) throw new Error("expected workflow-scope artifact");
  assertEquals(wfItem.jobName, undefined);
  assertEquals(wfItem.stepName, undefined);
});

const OTHER_MODEL_ID = "550e8400-e29b-41d4-a716-446655440004";
const OTHER_RUN_ID = "550e8400-e29b-41d4-a716-446655440005";

/**
 * Creates test data owned by a model method and recorded against a run.
 */
async function createRunData(
  name: string,
  runId: string,
  version = 1,
): Promise<Data> {
  const definitionHash = await computeDefinitionHash({
    type: "model-method",
    ref: "test:create",
  });
  return Data.create({
    name,
    version,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", specName: name, workflowRunId: runId },
    ownerDefinition: {
      definitionHash,
      ownerType: "model-method",
      ownerRef: "test:create",
      workflowRunId: runId,
    },
  });
}

function refFor(data: Data) {
  return {
    dataId: data.id,
    name: data.name,
    version: data.version,
    tags: { ...data.tags },
  };
}

Deno.test("WorkflowDataService.findAllForWorkflowRun: resolves an older run's artifact at its recorded version", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createRunData("result", TEST_RUN_ID, 1);
  const v2 = await createRunData("result", OTHER_RUN_ID, 2);
  const latest = [{ data: v2, modelType, modelId: TEST_MODEL_ID }];
  const stored = [{ data: v1, modelType, modelId: TEST_MODEL_ID }, ...latest];

  const run = createTestRun([{ stepName: "create", artifacts: [refFor(v1)] }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(latest, stored),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.version, 1);
  assertEquals(result[0].data.id, v1.id);
  assertEquals(
    result[0].contentPath,
    `.swamp/data/aws/ec2/vpc/${TEST_MODEL_ID}/result/1/raw`,
  );
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: explicit version selects the run's own version", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createRunData("result", TEST_RUN_ID, 1);
  const v2 = await createRunData("result", OTHER_RUN_ID, 2);
  const latest = [{ data: v2, modelType, modelId: TEST_MODEL_ID }];
  const stored = [{ data: v1, modelType, modelId: TEST_MODEL_ID }, ...latest];

  const run = createTestRun([{ stepName: "create", artifacts: [refFor(v1)] }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(latest, stored),
  );

  const found = await service.findByNameInWorkflowRun(run, "result", 1);
  assertEquals(found?.data.version, 1);

  // Version 2 exists on disk but was produced by a different run.
  const other = await service.findByNameInWorkflowRun(run, "result", 2);
  assertEquals(other, null);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: never returns a same-named item from another model", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const ours = await createRunData("result", TEST_RUN_ID, 1);
  const theirs = await createRunData("result", OTHER_RUN_ID, 1);
  // Our recorded version was GC'd; only the other model's v1 remains.
  const global = [{ data: theirs, modelType, modelId: OTHER_MODEL_ID }];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [refFor(ours)],
  }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(global),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 0);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: picks the owning model when several share a data name", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const theirs = await createRunData("result", OTHER_RUN_ID, 1);
  const ours = await createRunData("result", TEST_RUN_ID, 1);
  const global = [
    { data: theirs, modelType, modelId: OTHER_MODEL_ID },
    { data: ours, modelType, modelId: TEST_MODEL_ID },
  ];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [refFor(ours)],
  }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(global),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].modelId, TEST_MODEL_ID);
  assertEquals(result[0].data.id, ours.id);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: versions sharing one id resolve to the recorded version", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createRunData("result", TEST_RUN_ID, 1);
  // withNewVersion keeps the id, so id alone cannot identify the version.
  const v2 = v1.withNewVersion({ version: 2 });
  const latest = [{ data: v2, modelType, modelId: TEST_MODEL_ID }];
  const stored = [{ data: v1, modelType, modelId: TEST_MODEL_ID }, ...latest];

  const run = createTestRun([{ stepName: "create", artifacts: [refFor(v1)] }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(latest, stored),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.version, 1);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: accepts a recorded version owned by the run when the dataId differs", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const stored = await createRunData("result", TEST_RUN_ID, 1);
  const global = [{ data: stored, modelType, modelId: TEST_MODEL_ID }];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [{ ...refFor(stored), dataId: TEST_GC_DATA_ID }],
  }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(global),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.id, stored.id);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: a GC'd recorded version does not fall back to the latest", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createRunData("result", TEST_RUN_ID, 1);
  const v2 = await createRunData("result", OTHER_RUN_ID, 2);
  // v1 was garbage-collected; only v2 remains on disk.
  const global = [{ data: v2, modelType, modelId: TEST_MODEL_ID }];

  const run = createTestRun([{ stepName: "create", artifacts: [refFor(v1)] }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(global),
  );

  assertEquals((await service.findAllForWorkflowRun(run)).length, 0);
  assertEquals(await service.findByNameInWorkflowRun(run, "result"), null);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: workflow-scope artifacts resolve at the recorded version", async () => {
  const workflowModelType = ModelType.create("workflow");
  const v1 = await createRunData("report-summary", TEST_RUN_ID, 1);
  const v2 = await createRunData("report-summary", OTHER_RUN_ID, 2);
  const latest = [{
    data: v2,
    modelType: workflowModelType,
    modelId: TEST_WORKFLOW_ID,
  }];
  const stored = [{
    data: v1,
    modelType: workflowModelType,
    modelId: TEST_WORKFLOW_ID,
  }, ...latest];

  const run = WorkflowRun.fromData({
    id: TEST_RUN_ID,
    workflowId: TEST_WORKFLOW_ID,
    workflowName: "test-workflow",
    status: "succeeded",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    jobs: [],
    workflowDataArtifacts: [refFor(v1)],
  });
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(latest, stored),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.version, 1);
  assertEquals(result[0].modelType.normalized, "workflow");
  assertEquals(result[0].modelId, TEST_WORKFLOW_ID);
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: without a version, the run's highest recorded version wins", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createRunData("result", TEST_RUN_ID, 1);
  const v2 = await createRunData("result", TEST_RUN_ID, 2);
  const latest = [{ data: v2, modelType, modelId: TEST_MODEL_ID }];
  const stored = [{ data: v1, modelType, modelId: TEST_MODEL_ID }, ...latest];

  const run = createTestRun([
    { stepName: "first", artifacts: [refFor(v1)] },
    { stepName: "second", artifacts: [refFor(v2)] },
  ]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(latest, stored),
  );

  const found = await service.findByNameInWorkflowRun(run, "result");
  assertEquals(found?.data.version, 2);
  assertEquals(found?.stepName, "second");
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: an ambiguous run-id-only match is not returned", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  // Two models wrote "result" v1 in the same run; the step's own v1 is gone.
  const ours = await createRunData("result", TEST_RUN_ID, 1);
  const theirs = await createRunData("result", TEST_RUN_ID, 1);
  const alsoTheirs = await createRunData("result", TEST_RUN_ID, 1);
  const global = [
    { data: theirs, modelType, modelId: OTHER_MODEL_ID },
    { data: alsoTheirs, modelType, modelId: TEST_WORKFLOW_ID },
  ];

  const run = createTestRun([{
    stepName: "create",
    artifacts: [refFor(ours)],
  }]);
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(global),
  );

  assertEquals((await service.findAllForWorkflowRun(run)).length, 0);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: an unreadable candidate in another model is skipped", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const ours = await createRunData("result", TEST_RUN_ID, 1);
  const theirs = await createRunData("result", OTHER_RUN_ID, 1);
  const global = [
    { data: theirs, modelType, modelId: OTHER_MODEL_ID },
    { data: ours, modelType, modelId: TEST_MODEL_ID },
  ];
  const repo = createMockDataRepo(global);
  const findByName = repo.findByName.bind(repo);
  repo.findByName = (type, modelId, name, version) =>
    modelId === OTHER_MODEL_ID
      ? Promise.reject(new SyntaxError("corrupt metadata"))
      : findByName(type, modelId, name, version);

  const run = createTestRun([{
    stepName: "create",
    artifacts: [refFor(ours)],
  }]);
  const service = new WorkflowDataService(createMockDefinitionRepo(), repo);

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].modelId, TEST_MODEL_ID);
});
