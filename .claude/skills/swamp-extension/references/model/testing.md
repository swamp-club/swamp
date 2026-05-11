# Unit Testing Extension Models

The `@systeminit/swamp-testing` package provides `createModelTestContext()` for
unit testing extension model `execute` functions without real infrastructure.

Install: `deno add jsr:@systeminit/swamp-testing`

> **If your `_test.ts` imports the model source directly and fails with TS7006
> under strict mode**, see [typing.md](typing.md) for the
> `satisfies ModelDefinition<...>` escape hatch.

## createModelTestContext Options

| Option            | Default             | Description                               |
| ----------------- | ------------------- | ----------------------------------------- |
| `globalArgs`      | `{}`                | Global arguments for the execute function |
| `definition`      | auto-generated      | `{ name, id, version, tags }` overrides   |
| `methodName`      | `"run"`             | Name of the executing method              |
| `repoDir`         | `"/tmp/swamp-test"` | Repository directory path                 |
| `signal`          | never-aborted       | AbortSignal for cancellation testing      |
| `storedResources` | `{}`                | Pre-seed data for `readResource` calls    |
| `onEvent`         | captures only       | Callback for domain events                |

## Inspection Helpers

```typescript
const {
  context, // MethodContext to pass to execute()
  getWrittenResources, // Array<{ specName, name, data, handle }>
  getWrittenFiles, // Array<{ specName, name, content, handle }>
  getLogs, // Array<{ level, message, args }>
  getLogsByLevel, // (level) => filtered logs
  getEvents, // Array<{ type, ...fields }>
} = createModelTestContext();
```

## Testing CRUD Lifecycle Models

Seed stored resources to test methods that read existing state:

```typescript
Deno.test("sync refreshes state from API", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    storedResources: {
      "main": { instanceId: "i-abc123", status: "running" },
    },
  });

  await model.methods.sync.execute({}, context);
  assertEquals(getWrittenResources()[0].data.instanceId, "i-abc123");
});
```

## Injectable Client Pattern

Accept an optional client parameter in the method arguments so tests can inject
a stub instead of the live SDK:

```typescript
// In the model execute function
execute: (async (args, context) => {
  const s3 = args._s3Client ??
    new S3Client({ region: context.globalArgs.region });
  await s3.send(new CreateBucketCommand({ Bucket: context.globalArgs.bucket }));
  // ...
});
```

```typescript
// In the test
const mockS3 = { send: () => Promise.resolve({}) };
const { context } = createModelTestContext({
  globalArgs: { region: "us-east-1", bucket: "my-bucket" },
});

await model.methods.create.execute({ _s3Client: mockS3 }, context);
```

### Alternative: Extract Logic Into Testable Functions

Extract business logic into a separate function with explicit dependencies. This
keeps the `execute` function thin:

```typescript
// extensions/models/_lib/vpc_ops.ts
export async function createVpc(
  client: { send: (cmd: unknown) => Promise<unknown> },
  cidr: string,
) {
  const result = await client.send({ CidrBlock: cidr });
  return { vpcId: result.Vpc.VpcId, cidr, status: "available" };
}
```

```typescript
// Test the extracted function directly — no createModelTestContext needed
const mockClient = {
  send: () => Promise.resolve({ Vpc: { VpcId: "vpc-123" } }),
};
const result = await createVpc(mockClient, "10.0.0.0/16");
assertEquals(result.vpcId, "vpc-123");
```

## Other Testing Patterns

**Logs**: Use `getLogs()` or `getLogsByLevel("info")` to assert on logged
messages.

**Cancellation**: Pass `signal: controller.signal` and call `controller.abort()`
to test abort handling.

**Events**: Use `getEvents()` to inspect domain events emitted via
`context.onEvent`.

**Handle metadata**: Assert on `handle.metadata.lifetime`,
`handle.metadata.contentType`, etc. to verify data lifecycle properties.

**In-repo extensions**: Import directly from `../../packages/testing/mod.ts`
instead of the JSR package.
