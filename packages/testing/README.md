# @systeminit/swamp-testing

Test utilities for [swamp](https://github.com/systeminit/swamp) extension
models. Provides a fake `MethodContext` for unit testing `execute` functions
without running against real infrastructure.

## Installation

```bash
deno add jsr:@systeminit/swamp-testing
```

Or add to your `deno.json` imports:

```json
{
  "imports": {
    "@systeminit/swamp-testing": "jsr:@systeminit/swamp-testing"
  }
}
```

## Usage

```typescript
import { createModelTestContext } from "@systeminit/swamp-testing";
import { assertEquals } from "@std/assert";
import { model } from "./my_model.ts";

Deno.test("run method writes expected resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { message: "hello" },
  });

  await model.methods.run.execute({}, context);

  const resources = getWrittenResources();
  assertEquals(resources.length, 1);
  assertEquals(resources[0].data.message, "HELLO");
});
```

## `createModelTestContext` Options

| Option            | Default             | Description                                           |
| ----------------- | ------------------- | ----------------------------------------------------- |
| `globalArgs`      | `{}`                | Global arguments passed to the execute function       |
| `definition`      | auto-generated      | Definition metadata (`name`, `id`, `version`, `tags`) |
| `methodName`      | `"run"`             | Name of the method being executed                     |
| `repoDir`         | `"/tmp/swamp-test"` | Repository directory path                             |
| `signal`          | never-aborted       | Abort signal for cancellation testing                 |
| `storedResources` | `{}`                | Pre-seed data for `readResource` calls                |
| `onEvent`         | captures only       | Optional callback for domain events                   |

## Inspection Helpers

The return value includes helpers to inspect what happened during execution:

```typescript
const {
  context, // MethodContext to pass to execute()
  getWrittenResources, // Returns Array<{ specName, name, data, handle }>
  getWrittenFiles, // Returns Array<{ specName, name, content, handle }>
  getLogs, // Returns Array<{ level, message, args }>
  getLogsByLevel, // (level) => filtered log entries
  getEvents, // Returns Array<{ type, ...fields }>
} = createModelTestContext();
```

## Testing CRUD Lifecycle Models

Seed stored resources to test methods that read existing state:

```typescript
Deno.test("sync refreshes state", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    storedResources: {
      "main": { instanceId: "i-abc123", status: "running" },
    },
  });

  await model.methods.sync.execute({}, context);

  const resources = getWrittenResources();
  assertEquals(resources[0].data.instanceId, "i-abc123");
});
```

## Injectable Client Pattern

For models that call external APIs, accept an optional client parameter so tests
can pass a stub:

```typescript
// In your model
execute: (async (args, context) => {
  const s3 = args._s3Client ??
    new S3Client({ region: context.globalArgs.region });
  // ...
});

// In your test
const mockClient = { send: () => Promise.resolve({ Bucket: "test" }) };
await model.methods.create.execute({ _s3Client: mockClient }, context);
```

## License

AGPL-3.0-only — see
[LICENSE](https://github.com/systeminit/swamp/blob/main/LICENSE).
