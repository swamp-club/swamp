# Unit Testing Vault Providers

The `@systeminit/swamp-testing` package provides `createVaultTestContext()` for
unit testing code that interacts with vault providers without real secret
storage.

Install: `deno add jsr:@systeminit/swamp-testing`

## createVaultTestContext Options

| Option           | Default        | Description                           |
| ---------------- | -------------- | ------------------------------------- |
| `name`           | `"test-vault"` | Vault provider name                   |
| `secrets`        | `{}`           | Pre-seed secrets for `get()` calls    |
| `throwOnMissing` | `true`         | Reject on missing keys vs return `""` |

## Inspection Helpers

```typescript
const {
  vault, // VaultProvider to pass to code under test
  getStoredSecrets, // () => Record<string, string>
  getOperations, // () => VaultOperation[]
  getOperationsByMethod, // (method) => VaultOperation[]
} = createVaultTestContext();
```

## Testing Vault Provider Implementations

Test your `VaultProvider` implementation directly:

```typescript
import { assertEquals } from "@std/assert";
import { vault } from "./my_vault.ts";

Deno.test("stores and retrieves secrets", async () => {
  const provider = vault.createProvider("test", {});
  await provider.put("api-key", "sk-123");
  assertEquals(await provider.get("api-key"), "sk-123");
});
```

## Testing Code That Reads From Vaults

Pre-seed secrets to test code that depends on vault values:

```typescript
import { createVaultTestContext } from "@systeminit/swamp-testing";

Deno.test("model reads API key from vault", async () => {
  const { vault, getOperations } = createVaultTestContext({
    secrets: { "api-key": "sk-test-123" },
  });

  const key = await vault.get("api-key");
  assertEquals(key, "sk-test-123");
  assertEquals(getOperations().length, 1);
  assertEquals(getOperations()[0].method, "get");
});
```

## Verifying Side Effects

Use `getStoredSecrets()` to verify what was written:

```typescript
Deno.test("rotation writes new secret", async () => {
  const { vault, getStoredSecrets } = createVaultTestContext({
    secrets: { "api-key": "old-value" },
  });

  await vault.put("api-key", "new-value");
  assertEquals(getStoredSecrets()["api-key"], "new-value");
});
```

## In-Repo Extensions

Import directly from the testing package source:

```typescript
import { createVaultTestContext } from "../../packages/testing/mod.ts";
```
