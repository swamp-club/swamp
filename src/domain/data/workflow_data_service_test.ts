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
 *
 * `globalData` is the latest version of each item (what `findAllGlobal`
 * returns). `olderVersions` adds versions that only `findByName` can reach.
 */
function createMockDataRepo(
  globalData: Array<{ data: Data; modelType: ModelType; modelId: string }>,
  olderVersions: Array<{ data: Data; modelType: ModelType; modelId: string }> =
    [],
): FileSystemUnifiedDataRepository {
  const stored = [...globalData, ...olderVersions];
  return {
    findAllGlobal: () => Promise.resolve(globalData),
    findByName: (
      type: ModelType,
      modelId: string,
      dataName: string,
      version?: number,
    ) => {
      const matches = stored.filter((s) =>
        s.modelType.normalized === type.normalized &&
        s.modelId === modelId && s.data.name === dataName &&
        (version === undefined || s.data.version === version)
      );
      matches.sort((a, b) => b.data.version - a.data.version);
      return Promise.resolve(matches[0]?.data ?? null);
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

Deno.test("WorkflowDataService.findAllForWorkflowRun resolves the version the run recorded, not the latest", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createTestData("vpc-state");
  const v2 = v1.withNewVersion({ version: 2 });
  const v3 = v1.withNewVersion({ version: 3 });

  const run = createTestRun([{
    stepName: "create",
    artifacts: [{
      dataId: v1.id,
      name: "vpc-state",
      version: 1,
      tags: { type: "resource" },
    }],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(
      [{ data: v3, modelType, modelId: TEST_MODEL_ID }],
      [
        { data: v1, modelType, modelId: TEST_MODEL_ID },
        { data: v2, modelType, modelId: TEST_MODEL_ID },
      ],
    ),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.version, 1);
  assertEquals(
    result[0].contentPath,
    `.swamp/data/aws/ec2/vpc/${TEST_MODEL_ID}/vpc-state/1/raw`,
  );
});

Deno.test("WorkflowDataService.findAllForWorkflowRun resolves workflow-scope artifacts at their recorded version", async () => {
  const workflowModelType = ModelType.create("workflow");
  const tags = {
    type: "report",
    reportName: "@swamp/workflow-summary",
    reportScope: "workflow",
  };
  const v1 = await createTestData("report-swamp-workflow-summary", tags);
  const v2 = v1.withNewVersion({ version: 2 });

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
      dataId: v1.id,
      name: "report-swamp-workflow-summary",
      version: 1,
      tags,
    }],
  });

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(
      [{ data: v2, modelType: workflowModelType, modelId: TEST_WORKFLOW_ID }],
      [{ data: v1, modelType: workflowModelType, modelId: TEST_WORKFLOW_ID }],
    ),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 1);
  assertEquals(result[0].data.version, 1);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun skips a recorded version that was GC'd instead of substituting the latest", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createTestData("vpc-state");
  const v2 = v1.withNewVersion({ version: 2 });

  const run = createTestRun([{
    stepName: "create",
    artifacts: [{
      dataId: v1.id,
      name: "vpc-state",
      version: 1,
      tags: { type: "resource" },
    }],
  }]);

  // Only v2 remains on disk.
  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo([{ data: v2, modelType, modelId: TEST_MODEL_ID }]),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 0);
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: a run that wrote a name twice resolves each version when asked", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createTestData("vpc-state");
  const v2 = v1.withNewVersion({ version: 2 });
  const v3 = v1.withNewVersion({ version: 3 });
  const v4 = v1.withNewVersion({ version: 4 });

  const run = createTestRun([
    {
      stepName: "create-a",
      artifacts: [{
        dataId: v1.id,
        name: "vpc-state",
        version: 2,
        tags: { type: "resource" },
      }],
    },
    {
      stepName: "create-b",
      artifacts: [{
        dataId: v1.id,
        name: "vpc-state",
        version: 3,
        tags: { type: "resource" },
      }],
    },
  ]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(
      [{ data: v4, modelType, modelId: TEST_MODEL_ID }],
      [
        { data: v1, modelType, modelId: TEST_MODEL_ID },
        { data: v2, modelType, modelId: TEST_MODEL_ID },
        { data: v3, modelType, modelId: TEST_MODEL_ID },
      ],
    ),
  );

  const second = await service.findByNameInWorkflowRun(run, "vpc-state", 2);
  assertEquals(second?.data.version, 2);
  assertEquals(second?.stepName, "create-a");

  const third = await service.findByNameInWorkflowRun(run, "vpc-state", 3);
  assertEquals(third?.data.version, 3);
  assertEquals(third?.stepName, "create-b");

  // Version 4 was written by a later run, not this one.
  const later = await service.findByNameInWorkflowRun(run, "vpc-state", 4);
  assertEquals(later, null);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: a same-named item with a different id is not the run's data", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  // The run recorded an id that no longer matches any stored item.
  const recreated = await createTestData("vpc-state");
  const recreatedV2 = recreated.withNewVersion({ version: 2 });

  const run = createTestRun([{
    stepName: "create",
    artifacts: [{
      dataId: TEST_GC_DATA_ID,
      name: "vpc-state",
      version: 1,
      tags: { type: "resource" },
    }],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(
      [{ data: recreatedV2, modelType, modelId: TEST_MODEL_ID }],
      [{ data: recreated, modelType, modelId: TEST_MODEL_ID }],
    ),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 0);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: a name several models hold is not guessed", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const otherModelId = "550e8400-e29b-41d4-a716-446655440004";
  const mine = await createTestData("report-swamp-method-summary");
  const theirs = await createTestData("report-swamp-method-summary");

  const run = createTestRun([{
    stepName: "create",
    artifacts: [{
      dataId: TEST_GC_DATA_ID,
      name: "report-swamp-method-summary",
      version: 1,
      tags: { type: "report" },
    }],
  }]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo([
      { data: theirs, modelType, modelId: otherModelId },
      { data: mine, modelType, modelId: TEST_MODEL_ID },
    ]),
  );

  const result = await service.findAllForWorkflowRun(run);
  assertEquals(result.length, 0);
});

Deno.test("WorkflowDataService.findAllForWorkflowRun: data renamed after the run no longer resolves under its old name", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const otherModelId = "550e8400-e29b-41d4-a716-446655440004";
  const v1 = await createTestData("vpc-state");
  // A rename saves the data under the new name with a new id, and the
  // latest projection follows the rename, so neither the run's id nor its
  // name is indexed for that model.
  const renamed = await createTestData("vpc-main");
  // Another model holds an unrelated item with the old name and version;
  // it must not be returned in place of the renamed one.
  const unrelated = await createTestData("vpc-state");

  const run = createTestRun([{
    stepName: "create",
    artifacts: [{
      dataId: v1.id,
      name: "vpc-state",
      version: 1,
      tags: { type: "resource" },
    }],
  }]);

  const findByNameCalls: string[] = [];
  const repo = createMockDataRepo(
    [
      { data: renamed, modelType, modelId: TEST_MODEL_ID },
      { data: unrelated, modelType, modelId: otherModelId },
    ],
    [{ data: v1, modelType, modelId: TEST_MODEL_ID }],
  );
  const findByName = repo.findByName.bind(repo);
  repo.findByName = (type, modelId, name, version) => {
    findByNameCalls.push(modelId);
    return findByName(type, modelId, name, version);
  };

  const service = new WorkflowDataService(createMockDefinitionRepo(), repo);

  const result = await service.findAllForWorkflowRun(run);
  // Only owners whose latest data has the name are asked, and the
  // unrelated item's id does not match, so nothing is returned.
  assertEquals(findByNameCalls, [otherModelId]);
  assertEquals(result.length, 0);
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: dataId tells apart two models that wrote the same name and version", async () => {
  const modelType = ModelType.create("command/shell");
  const otherModelId = "550e8400-e29b-41d4-a716-446655440004";
  const tags = { type: "report", reportName: "@swamp/method-summary" };
  const mine = await createTestData("report-swamp-method-summary", tags);
  const theirs = await createTestData("report-swamp-method-summary", tags);

  const run = createTestRun([
    {
      stepName: "a",
      artifacts: [{
        dataId: mine.id,
        name: "report-swamp-method-summary",
        version: 1,
        tags,
      }],
    },
    {
      stepName: "b",
      artifacts: [{
        dataId: theirs.id,
        name: "report-swamp-method-summary",
        version: 1,
        tags,
      }],
    },
  ]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo([
      { data: mine, modelType, modelId: TEST_MODEL_ID },
      { data: theirs, modelType, modelId: otherModelId },
    ]),
  );

  const a = await service.findByNameInWorkflowRun(
    run,
    "report-swamp-method-summary",
    1,
    mine.id,
  );
  assertEquals(a?.modelId, TEST_MODEL_ID);
  assertEquals(a?.stepName, "a");

  const b = await service.findByNameInWorkflowRun(
    run,
    "report-swamp-method-summary",
    1,
    theirs.id,
  );
  assertEquals(b?.modelId, otherModelId);
  assertEquals(b?.stepName, "b");

  const none = await service.findByNameInWorkflowRun(
    run,
    "report-swamp-method-summary",
    1,
    TEST_GC_DATA_ID,
  );
  assertEquals(none, null);
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: without a version, returns the run's last write of the name", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const v1 = await createTestData("vpc-state");
  const v2 = v1.withNewVersion({ version: 2 });
  const v3 = v1.withNewVersion({ version: 3 });
  const v4 = v1.withNewVersion({ version: 4 });

  const run = createTestRun([
    {
      stepName: "create-a",
      artifacts: [{
        dataId: v1.id,
        name: "vpc-state",
        version: 2,
        tags: { type: "resource" },
      }],
    },
    {
      stepName: "create-b",
      artifacts: [{
        dataId: v1.id,
        name: "vpc-state",
        version: 3,
        tags: { type: "resource" },
      }],
    },
  ]);

  const service = new WorkflowDataService(
    createMockDefinitionRepo(),
    createMockDataRepo(
      [{ data: v4, modelType, modelId: TEST_MODEL_ID }],
      [
        { data: v2, modelType, modelId: TEST_MODEL_ID },
        { data: v3, modelType, modelId: TEST_MODEL_ID },
      ],
    ),
  );

  const result = await service.findByNameInWorkflowRun(run, "vpc-state");
  assertEquals(result?.data.version, 3);
  assertEquals(result?.stepName, "create-b");
});

Deno.test("WorkflowDataService.findByNameInWorkflowRun: resolves only the refs that match, not the whole run", async () => {
  const modelType = ModelType.create("aws/ec2/vpc");
  const wanted = await createTestData("vpc-state");
  const others = await Promise.all(
    ["a", "b", "c"].map((n) => createTestData(`other-${n}`)),
  );

  const run = createTestRun([{
    stepName: "create",
    artifacts: [wanted, ...others].map((d) => ({
      dataId: d.id,
      name: d.name,
      version: 1,
      tags: { type: "resource" },
    })),
  }]);

  const repo = createMockDataRepo(
    [wanted, ...others].map((data) => ({
      data,
      modelType,
      modelId: TEST_MODEL_ID,
    })),
  );
  const looked: string[] = [];
  const findByName = repo.findByName.bind(repo);
  repo.findByName = (type, modelId, name, version) => {
    looked.push(name);
    return findByName(type, modelId, name, version);
  };

  const service = new WorkflowDataService(createMockDefinitionRepo(), repo);
  const result = await service.findByNameInWorkflowRun(run, "vpc-state");
  assertEquals(result?.data.name, "vpc-state");
  assertEquals(looked, ["vpc-state"]);
});
