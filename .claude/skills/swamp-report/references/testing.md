# Unit Testing Report Extensions

The `@systeminit/swamp-testing` package provides `createReportTestContext()` for
unit testing report `execute` functions without running real model methods or
accessing real data repositories.

Install: `deno add jsr:@systeminit/swamp-testing`

## createReportTestContext Options

All scopes share these base options:

| Option          | Default             | Description                            |
| --------------- | ------------------- | -------------------------------------- |
| `scope`         | required            | `"method"`, `"model"`, or `"workflow"` |
| `dataArtifacts` | `[]`                | Pre-seed data for the fake repository  |
| `definitions`   | `[]`                | Pre-seed definitions                   |
| `repoDir`       | `"/tmp/swamp-test"` | Repository directory path              |

Method/model scope adds: `modelType`, `modelId`, `definition`, `globalArgs`,
`methodArgs`, `methodName`, `executionStatus`, `errorMessage`, `dataHandles`.

Workflow scope adds: `workflowId`, `workflowRunId`, `workflowName`,
`workflowStatus`, `stepExecutions`.

## What You Get

```typescript
const {
  context, // ReportContext to pass to your execute function
  getLogs, // () => CapturedReportLog[]
  getLogsByLevel, // (level) => CapturedReportLog[]
} = createReportTestContext({ scope: "method" });
```

## Testing a Method-Scope Report

```typescript
import { createReportTestContext } from "@systeminit/swamp-testing";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { report } from "./my_report.ts";

Deno.test("report generates cost summary", async () => {
  const { context } = createReportTestContext({
    scope: "method",
    modelType: "aws/ec2-instance",
    methodName: "create",
    executionStatus: "succeeded",
    dataHandles: [],
  });

  const result = await report.execute(context);
  assertStringIncludes(result.markdown, "## Cost");
  assertEquals(typeof result.json.estimatedCost, "number");
});
```

## Pre-Seeding Data for Reports

Reports that read model data use `context.dataRepository`. Pre-seed it:

```typescript
Deno.test("report reads model data", async () => {
  const content = new TextEncoder().encode('{"instanceId":"i-123"}');
  const { context } = createReportTestContext({
    scope: "method",
    dataArtifacts: [
      {
        modelType: "aws/ec2",
        modelId: "my-ec2",
        data: {
          name: "main",
          kind: "resource",
          dataId: "d1",
          version: 1,
          size: content.length,
          contentType: "application/json",
          attributes: { instanceId: "i-123" },
        },
        content,
      },
    ],
  });

  const data = await context.dataRepository.findByName(
    "aws/ec2",
    "my-ec2",
    "main",
  );
  assertEquals(data!.attributes!.instanceId, "i-123");
});
```

## Testing Workflow-Scope Reports

```typescript
Deno.test("workflow report summarizes steps", async () => {
  const { context } = createReportTestContext({
    scope: "workflow",
    workflowName: "deploy-pipeline",
    workflowStatus: "succeeded",
    stepExecutions: [
      {
        jobName: "deploy",
        stepName: "create",
        modelName: "ec2",
        modelType: "aws/ec2",
        methodName: "create",
        status: "succeeded",
        dataHandles: [],
        methodArgs: {},
        modelId: "m1",
        globalArgs: {},
      },
    ],
  });

  const result = await report.execute(context);
  assertStringIncludes(result.markdown, "deploy-pipeline");
});
```

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import { createReportTestContext } from "../../packages/testing/mod.ts";
```
