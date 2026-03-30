// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { createReportTestContext } from "./report_test_context.ts";
import type {
  MethodReportContext,
  ModelReportContext,
  WorkflowReportContext,
} from "./report_types.ts";

// --- Method scope: defaults ---

Deno.test("createReportTestContext: method scope with defaults", () => {
  const { context } = createReportTestContext({ scope: "method" });
  assertEquals(context.scope, "method");
  const ctx = context as MethodReportContext;
  assertEquals(ctx.modelType, "test/model");
  assertEquals(ctx.methodName, "run");
  assertEquals(ctx.executionStatus, "succeeded");
  assertEquals(ctx.dataHandles, []);
  assertEquals(ctx.globalArgs, {});
  assertEquals(ctx.methodArgs, {});
  assertEquals(ctx.repoDir, "/tmp/swamp-test");
});

// --- Method scope: custom options ---

Deno.test("createReportTestContext: method scope with custom options", () => {
  const { context } = createReportTestContext({
    scope: "method",
    modelType: "aws/ec2",
    modelId: "my-id",
    methodName: "create",
    executionStatus: "failed",
    errorMessage: "timeout",
    globalArgs: { region: "us-east-1" },
    methodArgs: { force: true },
    definition: { name: "my-ec2", version: 3 },
    repoDir: "/custom/repo",
  });

  const ctx = context as MethodReportContext;
  assertEquals(ctx.modelType, "aws/ec2");
  assertEquals(ctx.modelId, "my-id");
  assertEquals(ctx.methodName, "create");
  assertEquals(ctx.executionStatus, "failed");
  assertEquals(ctx.errorMessage, "timeout");
  assertEquals(ctx.globalArgs, { region: "us-east-1" });
  assertEquals(ctx.definition.name, "my-ec2");
  assertEquals(ctx.definition.version, 3);
  assertEquals(ctx.repoDir, "/custom/repo");
});

// --- Model scope ---

Deno.test("createReportTestContext: model scope with defaults", () => {
  const { context } = createReportTestContext({ scope: "model" });
  assertEquals(context.scope, "model");
  const ctx = context as ModelReportContext;
  assertEquals(ctx.modelType, "test/model");
  assertEquals(ctx.executionStatus, "succeeded");
});

// --- Workflow scope: defaults ---

Deno.test("createReportTestContext: workflow scope with defaults", () => {
  const { context } = createReportTestContext({ scope: "workflow" });
  assertEquals(context.scope, "workflow");
  const ctx = context as WorkflowReportContext;
  assertEquals(ctx.workflowName, "test-workflow");
  assertEquals(ctx.workflowStatus, "succeeded");
  assertEquals(ctx.stepExecutions, []);
  assertEquals(typeof ctx.workflowId, "string");
  assertEquals(typeof ctx.workflowRunId, "string");
});

// --- Workflow scope: custom options ---

Deno.test("createReportTestContext: workflow scope with step executions", () => {
  const { context } = createReportTestContext({
    scope: "workflow",
    workflowName: "deploy-pipeline",
    workflowStatus: "failed",
    stepExecutions: [
      {
        jobName: "deploy",
        stepName: "create-instance",
        modelName: "ec2",
        modelType: "aws/ec2",
        methodName: "create",
        status: "succeeded",
        dataHandles: [],
        methodArgs: {},
        modelId: "m1",
        globalArgs: {},
      },
      {
        jobName: "deploy",
        stepName: "configure",
        modelName: "config",
        modelType: "aws/ssm",
        methodName: "apply",
        status: "failed",
        dataHandles: [],
        methodArgs: {},
        modelId: "m2",
        globalArgs: {},
      },
    ],
  });

  const ctx = context as WorkflowReportContext;
  assertEquals(ctx.workflowName, "deploy-pipeline");
  assertEquals(ctx.workflowStatus, "failed");
  assertEquals(ctx.stepExecutions.length, 2);
  assertEquals(ctx.stepExecutions[0].status, "succeeded");
  assertEquals(ctx.stepExecutions[1].status, "failed");
});

// --- Logger ---

Deno.test("createReportTestContext: logger captures all levels", () => {
  const { context, getLogs, getLogsByLevel } = createReportTestContext({
    scope: "method",
  });

  context.logger.debug("debug msg");
  context.logger.info("info msg");
  context.logger.warn("warn msg");
  context.logger.error("error msg");
  context.logger.fatal("fatal msg");

  assertEquals(getLogs().length, 5);
  assertEquals(getLogsByLevel("debug").length, 1);
  assertEquals(getLogsByLevel("info").length, 1);
  assertEquals(getLogsByLevel("warning").length, 1);
  assertEquals(getLogsByLevel("error").length, 1);
  assertEquals(getLogsByLevel("fatal").length, 1);
});

Deno.test("createReportTestContext: logger captures extra args", () => {
  const { context, getLogs } = createReportTestContext({ scope: "method" });
  context.logger.info("msg", { key: "val" }, 42);
  assertEquals(getLogs()[0].args, [{ key: "val" }, 42]);
});

// --- Data repository ---

Deno.test("createReportTestContext: dataRepository.findByName returns seeded data", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "aws/ec2",
        modelId: "m1",
        data: {
          name: "main",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: 100,
          contentType: "application/json",
          attributes: { instanceId: "i-123" },
        },
      },
    ],
  });

  const result = await context.dataRepository.findByName(
    "aws/ec2",
    "m1",
    "main",
  );
  assertEquals(result!.name, "main");
  assertEquals(result!.attributes!.instanceId, "i-123");
});

Deno.test("createReportTestContext: dataRepository.findByName returns null for missing", async () => {
  const { context } = createReportTestContext({ scope: "method" });
  const result = await context.dataRepository.findByName(
    "type",
    "id",
    "name",
  );
  assertEquals(result, null);
});

Deno.test("createReportTestContext: dataRepository.findByName filters by version", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "t",
        modelId: "m",
        data: {
          name: "a",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: 10,
          contentType: "application/json",
        },
      },
      {
        modelType: "t",
        modelId: "m",
        data: {
          name: "a",
          kind: "resource",
          dataId: "d2",
          version: 2,
          size: 20,
          contentType: "application/json",
        },
      },
    ],
  });

  const v1 = await context.dataRepository.findByName("t", "m", "a", 1);
  assertEquals(v1!.version, 1);
  const v2 = await context.dataRepository.findByName("t", "m", "a", 2);
  assertEquals(v2!.version, 2);
});

Deno.test("createReportTestContext: dataRepository.getContent returns seeded content", async () => {
  const content = new TextEncoder().encode('{"status":"running"}');
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "t",
        modelId: "m",
        data: {
          name: "main",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: content.length,
          contentType: "application/json",
        },
        content,
      },
    ],
  });

  const result = await context.dataRepository.getContent("t", "m", "main");
  assertEquals(new TextDecoder().decode(result!), '{"status":"running"}');
});

Deno.test("createReportTestContext: dataRepository.getContent returns null for no content", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "t",
        modelId: "m",
        data: {
          name: "main",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: 0,
          contentType: "application/json",
        },
      },
    ],
  });

  const result = await context.dataRepository.getContent("t", "m", "main");
  assertEquals(result, null);
});

Deno.test("createReportTestContext: dataRepository.findAllForModel returns matching", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "t",
        modelId: "m1",
        data: {
          name: "a",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: 10,
          contentType: "application/json",
        },
      },
      {
        modelType: "t",
        modelId: "m1",
        data: {
          name: "b",
          kind: "file",
          dataId: "d2",
          version: 1,
          size: 20,
          contentType: "text/plain",
        },
      },
      {
        modelType: "t",
        modelId: "m2",
        data: {
          name: "c",
          kind: "resource",
          dataId: "d3",
          version: 1,
          size: 30,
          contentType: "application/json",
        },
      },
    ],
  });

  const results = await context.dataRepository.findAllForModel("t", "m1");
  assertEquals(results.length, 2);
  assertEquals(results[0].name, "a");
  assertEquals(results[1].name, "b");
});

Deno.test("createReportTestContext: dataRepository.findAllGlobal returns all", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "t1",
        modelId: "m1",
        data: {
          name: "a",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: 10,
          contentType: "application/json",
        },
      },
      {
        modelType: "t2",
        modelId: "m2",
        data: {
          name: "b",
          kind: "resource",
          dataId: "d2",
          version: 1,
          size: 20,
          contentType: "application/json",
        },
      },
    ],
  });

  const results = await context.dataRepository.findAllGlobal();
  assertEquals(results.length, 2);
  assertEquals(results[0].modelType, "t1");
  assertEquals(results[1].modelType, "t2");
});

// --- Definition repository ---

Deno.test("createReportTestContext: definitionRepository.findByName returns seeded", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    definitions: [
      {
        modelType: "aws/ec2",
        definition: { id: "def1", name: "my-ec2", version: 1, tags: {} },
      },
    ],
  });

  const result = await context.definitionRepository.findByName(
    "aws/ec2",
    "my-ec2",
  );
  assertEquals(result!.name, "my-ec2");
  assertEquals(result!.id, "def1");
});

Deno.test("createReportTestContext: definitionRepository.findByName returns null for missing", async () => {
  const { context } = createReportTestContext({ scope: "method" });
  const result = await context.definitionRepository.findByName("t", "n");
  assertEquals(result, null);
});

Deno.test("createReportTestContext: definitionRepository.findAll returns matching type", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    definitions: [
      {
        modelType: "aws/ec2",
        definition: { id: "d1", name: "a", version: 1, tags: {} },
      },
      {
        modelType: "aws/ec2",
        definition: { id: "d2", name: "b", version: 1, tags: {} },
      },
      {
        modelType: "aws/s3",
        definition: { id: "d3", name: "c", version: 1, tags: {} },
      },
    ],
  });

  const results = await context.definitionRepository.findAll("aws/ec2");
  assertEquals(results.length, 2);
});

// --- Data returns clones ---

Deno.test("createReportTestContext: dataRepository returns clones", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "t",
        modelId: "m",
        data: {
          name: "main",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: 10,
          contentType: "application/json",
          attributes: { count: 0 },
        },
      },
    ],
  });

  const r1 = await context.dataRepository.findByName("t", "m", "main");
  r1!.attributes!.count = 999;
  const r2 = await context.dataRepository.findByName("t", "m", "main");
  assertEquals(r2!.attributes!.count, 0);
});

// --- getLogs returns copy ---

Deno.test("createReportTestContext: getLogs returns a copy", () => {
  const { context, getLogs } = createReportTestContext({ scope: "method" });

  context.logger.info("first");
  const snap1 = getLogs();
  context.logger.info("second");
  const snap2 = getLogs();

  assertEquals(snap1.length, 1);
  assertEquals(snap2.length, 2);
});
