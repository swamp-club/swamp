# Testing Vault Extensions

The `@systeminit/swamp-testing` package provides conformance suites and test
doubles for vault extensions.

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

Options:

| Option      | Default                     | Description             |
| ----------- | --------------------------- | ----------------------- |
| `keyPrefix` | `"swamp-conformance-test-"` | Namespace for test keys |
| `cleanup`   | `true`                      | Delete test keys after  |

## In-Memory Test Double

For testing code that _consumes_ a vault (not the vault itself):

```typescript
import { createVaultTestContext } from "@systeminit/swamp-testing";

Deno.test("code reads from vault", async () => {
  const { vault, getOperations } = createVaultTestContext({
    secrets: { "api-key": "sk-test-123" },
  });

  const key = await vault.get("api-key");
  assertEquals(key, "sk-test-123");
  assertEquals(getOperations().length, 1);
});
```

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import { assertVaultExportConformance } from "../../packages/testing/mod.ts";
```
