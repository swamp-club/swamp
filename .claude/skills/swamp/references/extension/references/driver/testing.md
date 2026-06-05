# Testing Execution Drivers

The `@systeminit/swamp-testing` package provides test context factories and mock
primitives for execution driver extensions.

Install: `deno add jsr:@systeminit/swamp-testing`

## createDriverTestContext

Builds a well-formed `ExecutionRequest` and callbacks that capture events:

```typescript
import { createDriverTestContext } from "@systeminit/swamp-testing";
import { assertEquals } from "@std/assert";
import { driver } from "./my_driver.ts";

Deno.test("driver executes method", async () => {
  const myDriver = driver.createDriver({});
  const { request, callbacks, getCapturedLogs } = createDriverTestContext({
    methodName: "run",
    globalArgs: { region: "us-east-1" },
  });

  const result = await myDriver.execute(request, callbacks);
  assertEquals(result.status, "success");
});
```

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

## Mocking External Calls

Drivers that call external services (HTTP APIs, CLI tools) can be tested using
mock primitives that intercept at the runtime boundary.

### Drivers that call `fetch()`

Use `withMockedFetch` for drivers that make HTTP requests via `fetch()`:

```typescript
import {
  createDriverTestContext,
  withMockedFetch,
} from "@systeminit/swamp-testing";

Deno.test("driver calls remote API", async () => {
  const { calls } = await withMockedFetch((req) => {
    if (req.url.includes("/execute")) {
      return Response.json({ status: "ok", output: "result" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }, async () => {
    const myDriver = driver.createDriver({ endpoint: "https://api.test" });
    const { request, callbacks } = createDriverTestContext();
    await myDriver.execute(request, callbacks);
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.test/execute");
});
```

### Drivers that shell out to CLI tools

Use `withMockedCommand` for drivers that use `Deno.Command`:

```typescript
import {
  createDriverTestContext,
  withMockedCommand,
} from "@systeminit/swamp-testing";

Deno.test("driver runs subprocess", async () => {
  const { result } = await withMockedCommand((cmd, args) => {
    if (cmd === "docker" && args.includes("run")) {
      return { stdout: '{"status":"success"}', code: 0 };
    }
    return { stdout: "", stderr: "not found", code: 1 };
  }, async () => {
    const myDriver = driver.createDriver({});
    const { request, callbacks } = createDriverTestContext();
    return await myDriver.execute(request, callbacks);
  });

  assertEquals(result.status, "success");
});
```

### Drivers that use AWS SDK

AWS SDK uses `node:https` internally. Use a local mock server with
`AWS_ENDPOINT_URL`:

```typescript
Deno.test({
  name: "driver calls AWS",
  sanitizeResources: false,
  fn: async () => {
    const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
      return Response.json({ result: "ok" });
    });
    const addr = server.addr as Deno.NetAddr;
    Deno.env.set("AWS_ENDPOINT_URL", `http://localhost:${addr.port}`);
    Deno.env.set("AWS_ACCESS_KEY_ID", "test");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test");

    try {
      const myDriver = driver.createDriver({ region: "us-east-1" });
      const { request, callbacks } = createDriverTestContext();
      const result = await myDriver.execute(request, callbacks);
      assertEquals(result.status, "success");
    } finally {
      Deno.env.delete("AWS_ENDPOINT_URL");
      await server.shutdown();
    }
  },
});
```

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import {
  createDriverTestContext,
  withMockedCommand,
  withMockedFetch,
} from "../../packages/testing/mod.ts";
```
