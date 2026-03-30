# Unit Testing Execution Drivers

The `@systeminit/swamp-testing` package provides `createDriverTestContext()` for
unit testing execution driver implementations without running real model
methods.

Install: `deno add jsr:@systeminit/swamp-testing`

## createDriverTestContext Options

| Option            | Default        | Description                   |
| ----------------- | -------------- | ----------------------------- |
| `protocolVersion` | `1`            | Protocol version              |
| `modelType`       | `"test/model"` | Model type identifier         |
| `modelId`         | auto-generated | Model/definition ID           |
| `methodName`      | `"run"`        | Method to execute             |
| `globalArgs`      | `{}`           | Global arguments              |
| `methodArgs`      | `{}`           | Method arguments              |
| `definitionMeta`  | auto-generated | Definition metadata overrides |
| `resourceSpecs`   | `undefined`    | Resource output spec metadata |
| `fileSpecs`       | `undefined`    | File output spec metadata     |
| `bundle`          | `undefined`    | Bundled module bytes          |
| `traceHeaders`    | `undefined`    | W3C Trace Context headers     |

## What You Get

```typescript
const {
  request, // ExecutionRequest with sensible defaults
  callbacks, // ExecutionCallbacks that capture events
  getCapturedLogs, // () => CapturedDriverLog[]
  getCapturedResourceEvents, // () => CapturedResourceEvent[]
} = createDriverTestContext();
```

## Testing a Driver Implementation

```typescript
import { createDriverTestContext } from "@systeminit/swamp-testing";
import { assertEquals } from "@std/assert";
import { driver } from "./my_driver.ts";

Deno.test("driver executes method successfully", async () => {
  const myDriver = driver.createDriver({});
  const { request, callbacks, getCapturedLogs } = createDriverTestContext({
    methodName: "run",
    globalArgs: { region: "us-east-1" },
  });

  const result = await myDriver.execute(request, callbacks);

  assertEquals(result.status, "success");
  assertEquals(result.outputs.length > 0, true);
});
```

## Testing Callback Events

```typescript
Deno.test("driver emits log lines", async () => {
  const myDriver = driver.createDriver({});
  const { request, callbacks, getCapturedLogs } = createDriverTestContext();

  await myDriver.execute(request, callbacks);

  const logs = getCapturedLogs();
  assertEquals(logs.length > 0, true);
  assertEquals(typeof logs[0].line, "string");
});
```

## Testing Error Handling

```typescript
Deno.test("driver reports errors gracefully", async () => {
  const myDriver = driver.createDriver({});
  const { request, callbacks } = createDriverTestContext({
    methodName: "nonexistent-method",
  });

  const result = await myDriver.execute(request, callbacks);
  assertEquals(result.status, "error");
  assertEquals(typeof result.error, "string");
});
```

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import { createDriverTestContext } from "../../packages/testing/mod.ts";
```
