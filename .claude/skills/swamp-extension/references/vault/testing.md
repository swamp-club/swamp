# Testing Vault Extensions

The `@systeminit/swamp-testing` package provides conformance suites, mock
primitives, and test doubles for vault extensions.

Install: `deno add jsr:@systeminit/swamp-testing`

## Export Conformance

One call replaces all structural boilerplate tests (metadata, config schema,
method existence):

```typescript
import { assertVaultExportConformance } from "@systeminit/swamp-testing";
import { vault } from "./my_vault.ts";

Deno.test("vault export conforms", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [{ region: "us-east-1" }],
    invalidConfigs: [{}, { region: "" }],
  });
});
```

This verifies: type matches naming pattern, name/description are non-empty,
configSchema accepts valid and rejects invalid configs, createProvider returns
an object with get/put/list/getName.

## Behavioral Conformance

Test the full VaultProvider contract against a real or mocked provider:

```typescript
import { assertVaultConformance } from "@systeminit/swamp-testing";

Deno.test("vault contract", async () => {
  const provider = vault.createProvider("test", { region: "us-east-1" });
  await assertVaultConformance(provider);
});
```

Tests: put/get roundtrip, get-missing rejects, put overwrites, list includes
stored keys, getName returns non-empty string. Test keys are prefixed with
`swamp-conformance-test-` and cleaned up automatically.

| Option      | Default                     | Description             |
| ----------- | --------------------------- | ----------------------- |
| `keyPrefix` | `"swamp-conformance-test-"` | Namespace for test keys |
| `cleanup`   | `true`                      | Delete test keys after  |

## Mocking External Calls

Test the exact production code path by intercepting at the runtime boundary. No
modification to extension source code required.

### CLI-based vaults (e.g. 1password `op`)

Use `withMockedCommand` to replace `Deno.Command` for the test duration:

```typescript
import { withMockedCommand } from "@systeminit/swamp-testing";
import { vault } from "./onepassword.ts";

Deno.test("get reads secret via op CLI", async () => {
  const { result, calls } = await withMockedCommand((cmd, args) => {
    if (cmd === "op" && args.includes("--version")) {
      return { stdout: "2.30.0", code: 0 };
    }
    if (cmd === "op" && args[0] === "read") {
      return { stdout: "sk-test-123", code: 0 };
    }
    return { stdout: "", stderr: "unknown", code: 1 };
  }, async () => {
    const provider = vault.createProvider("test", { op_vault: "Eng" });
    return await provider.get("api-key");
  });

  assertEquals(result, "sk-test-123");
  assertEquals(calls.length, 2); // --version + read
});
```

`withMockedCommand` supports two modes:

- **Handler function** — route dynamically by command and args
- **Sequential array** — return canned outputs in order

```typescript
// Sequential mode
await withMockedCommand([
  { stdout: "2.30.0", code: 0 },  // op --version
  { stdout: "sk-123", code: 0 },  // op read ...
], async () => { ... });
```

### HTTP SDK-based vaults (e.g. AWS Secrets Manager)

AWS SDK uses `node:https` internally, not `globalThis.fetch`. Use a local mock
server with `AWS_ENDPOINT_URL` to intercept the exact production code path:

```typescript
import { assertVaultConformance } from "@systeminit/swamp-testing";
import { vault } from "./aws_sm.ts";

Deno.test({
  name: "aws-sm vault passes full conformance",
  sanitizeResources: false, // AWS SDK connection pooling
  fn: async () => {
    const secrets = new Map<string, string>();

    const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
      const target = req.headers.get("x-amz-target") ?? "";
      const body = await req.json();

      if (target.includes("GetSecretValue")) {
        const val = secrets.get(body.SecretId);
        if (!val) {
          return Response.json(
            { __type: "ResourceNotFoundException" },
            { status: 400 },
          );
        }
        return Response.json({ SecretString: val });
      }
      if (target.includes("PutSecretValue")) {
        secrets.set(body.SecretId, body.SecretString);
        return Response.json({});
      }
      if (target.includes("CreateSecret")) {
        secrets.set(body.Name, body.SecretString);
        return Response.json({});
      }
      if (target.includes("ListSecrets")) {
        return Response.json({
          SecretList: [...secrets.keys()].map((n) => ({ Name: n })),
        });
      }
      return Response.json({}, { status: 400 });
    });

    const addr = server.addr as Deno.NetAddr;
    Deno.env.set("AWS_ENDPOINT_URL", `http://localhost:${addr.port}`);
    Deno.env.set("AWS_ACCESS_KEY_ID", "test");
    Deno.env.set("AWS_SECRET_ACCESS_KEY", "test");

    try {
      const provider = vault.createProvider("test", { region: "us-east-1" });
      await assertVaultConformance(provider);
    } finally {
      Deno.env.delete("AWS_ENDPOINT_URL");
      await server.shutdown();
    }
  },
});
```

### REST API-based vaults

Use `withMockedFetch` for vaults that call `fetch()` directly:

```typescript
import { withMockedFetch } from "@systeminit/swamp-testing";

await withMockedFetch(async (req) => {
  const body = await req.json();
  if (req.url.includes("/secrets/get")) {
    return Response.json({ value: "sk-123" });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}, async () => {
  const provider = vault.createProvider("test", { endpoint: "..." });
  assertEquals(await provider.get("key"), "sk-123");
});
```

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import {
  assertVaultExportConformance,
  withMockedCommand,
} from "../../packages/testing/mod.ts";
```
