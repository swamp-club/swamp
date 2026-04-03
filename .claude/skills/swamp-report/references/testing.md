# Testing Report Extensions

The `@systeminit/swamp-testing` package provides `createReportTestContext()` and
mock primitives for unit testing report `execute` functions without running real
model methods or accessing real data repositories.

Install: `deno add jsr:@systeminit/swamp-testing`

## createReportTestContext

Creates a fake `ReportContext` with pre-seeded data and definition repositories:

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

## Testing Reports That Read Data

Reports that read execution data via `getContent` need pre-seeded data
artifacts. Use the `dataArtifacts` option and provide `content` as raw bytes:

```typescript
Deno.test("report reads execution data via getContent", async () => {
  const stateData = { status: "active", instanceId: "i-abc123" };
  const content = new TextEncoder().encode(JSON.stringify(stateData));
  const { context } = createReportTestContext({
    scope: "method",
    modelType: "aws/ec2",
    modelId: "my-ec2",
    methodName: "create",
    executionStatus: "succeeded",
    dataHandles: [{
      name: "state-current",
      specName: "state",
      kind: "resource",
      dataId: "d1",
      version: 1,
      size: content.length,
      tags: { type: "resource", specName: "state" },
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 5,
        streaming: false,
        tags: { type: "resource", specName: "state" },
        ownerDefinition: { type: "model-method", ref: "create" },
      },
    }],
    dataArtifacts: [{
      modelType: "aws/ec2",
      modelId: "my-ec2",
      data: {
        name: "state-current",
        kind: "resource",
        dataId: "d1",
        version: 1,
        size: content.length,
        contentType: "application/json",
      },
      content,
    }],
  });

  // Read raw bytes and parse — same pattern as live reports
  const raw = await context.dataRepository.getContent(
    "aws/ec2",
    "my-ec2",
    "state-current",
    1,
  );
  const parsed = JSON.parse(new TextDecoder().decode(raw!));
  assertEquals(parsed.status, "active");
  assertEquals(parsed.instanceId, "i-abc123");
});
```

## Mocking External Calls

Reports that call external APIs (e.g., pricing APIs, cost calculators) can use
mock primitives to test without real infrastructure.

### Reports that call `fetch()`

```typescript
import {
  createReportTestContext,
  withMockedFetch,
} from "@systeminit/swamp-testing";

Deno.test("report fetches pricing data", async () => {
  const { calls } = await withMockedFetch((req) => {
    if (req.url.includes("/pricing")) {
      return Response.json({ hourlyRate: 0.023 });
    }
    return Response.json({}, { status: 404 });
  }, async () => {
    const { context } = createReportTestContext({
      scope: "method",
      modelType: "aws/ec2",
      methodName: "create",
      executionStatus: "succeeded",
      dataHandles: [],
    });

    const result = await report.execute(context);
    assertStringIncludes(result.markdown, "0.023");
  });

  assertEquals(calls.length, 1);
});
```

### Reports that shell out to CLI tools

```typescript
import {
  createReportTestContext,
  withMockedCommand,
} from "@systeminit/swamp-testing";

Deno.test("report runs cost calculator CLI", async () => {
  await withMockedCommand((cmd, args) => {
    if (cmd === "infracost" && args.includes("--format")) {
      return { stdout: '{"totalMonthlyCost":"42.00"}', code: 0 };
    }
    return { stdout: "", stderr: "unknown", code: 1 };
  }, async () => {
    const { context } = createReportTestContext({ scope: "method" });
    const result = await report.execute(context);
    assertStringIncludes(result.json.monthlyCost, "42.00");
  });
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
import {
  createReportTestContext,
  withMockedFetch,
} from "../../packages/testing/mod.ts";
```
