---
name: swamp-extension-vault
description: Create user-defined TypeScript vaults for swamp — implement VaultProvider to securely store and retrieve secrets. Use when users want to extend swamp with custom vault backends. Triggers on "custom vault", "extension vault", "VaultProvider", "extensions/vaults", "create vault", "new vault type", "vault plugin", "vault implementation", "user-defined vault", "vault provider".
---

# Swamp Extension Vault

Create TypeScript vaults in `extensions/vaults/` that swamp loads at startup.

## When to Create a Custom Vault

**Create an extension vault when the built-in backends don't meet your needs.**

Before creating a custom vault, check what's available:

1. Built-in types: `env` (environment variables), `file` (local encrypted file)
2. Search community extensions: `swamp extension search vault`
3. If a community extension exists, install it instead of building from scratch
4. Only create a custom vault if nothing fits

Extensions from trusted collectives (`@swamp/*`, `@si/*`, and your membership
collectives) auto-resolve on first use — no manual `extension pull` needed. Use
`swamp extension trust list` to see which collectives are trusted. For local or
private extensions, use `swamp extension source add <path>` to load them without
publishing (see `swamp-repo` skill).

Custom vaults let you:

- Store secrets in any backend (AWS Secrets Manager, Azure Key Vault, HashiCorp
  Vault, 1Password, etc.)
- Implement custom secret retrieval and storage logic
- Integrate with your organization's secret management infrastructure

## Quick Reference

| Task                | Command/Action                                 |
| ------------------- | ---------------------------------------------- |
| Search community    | `swamp extension search vault --json`          |
| Create vault        | Create `extensions/vaults/my-vault/mod.ts`     |
| Verify registration | `swamp vault status --json`                    |
| Check config        | View `.swamp.yaml` vault section               |
| Push extension      | `swamp extension push manifest.yaml --json`    |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run` |

## Quick Start

```typescript
// extensions/vaults/my-vault/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  endpoint: z.string().url(),
  token: z.string(),
});

export const vault = {
  type: "@myorg/my-vault",
  name: "My Custom Vault",
  description: "Retrieves secrets from a custom backend",
  configSchema: ConfigSchema,
  createProvider: (name: string, config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    const secrets = new Map<string, string>();

    return {
      get: async (secretKey: string): Promise<string> => {
        // Retrieve secret from your backend
        const response = await fetch(
          `${parsed.endpoint}/secrets/${secretKey}`,
          { headers: { Authorization: `Bearer ${parsed.token}` } },
        );
        if (!response.ok) {
          throw new Error(
            `Failed to get secret '${secretKey}': ${response.statusText}`,
          );
        }
        const data = await response.json();
        return data.value;
      },
      put: async (secretKey: string, secretValue: string): Promise<void> => {
        // Store secret in your backend
        const response = await fetch(
          `${parsed.endpoint}/secrets/${secretKey}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${parsed.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ value: secretValue }),
          },
        );
        if (!response.ok) {
          throw new Error(
            `Failed to put secret '${secretKey}': ${response.statusText}`,
          );
        }
      },
      list: async (): Promise<string[]> => {
        // List all secret keys
        const response = await fetch(
          `${parsed.endpoint}/secrets`,
          { headers: { Authorization: `Bearer ${parsed.token}` } },
        );
        if (!response.ok) {
          throw new Error(`Failed to list secrets: ${response.statusText}`);
        }
        const data = await response.json();
        return data.keys;
      },
      getName: (): string => name,
    };
  },
};
```

## Export Contract

| Field            | Required | Description                                         |
| ---------------- | -------- | --------------------------------------------------- |
| `type`           | Yes      | Namespaced identifier (`@collective/name`)          |
| `name`           | Yes      | Human-readable display name                         |
| `description`    | Yes      | What this vault does                                |
| `configSchema`   | No       | Zod schema for validating config from `.swamp.yaml` |
| `createProvider` | Yes      | Factory function `(name, config) => VaultProvider`  |

The `type` must match the pattern `@collective/name` or `collective/name` (e.g.,
`@myorg/custom-vault`). Reserved collectives (`swamp`, `si`) cannot be used.

**Note:** The `createProvider` function receives two arguments: `name` (the
vault instance name from `.swamp.yaml`) and `config` (the provider-specific
configuration object). This differs from datastore providers which only receive
`config`.

## VaultProvider Methods

| Method    | Required | Description                             |
| --------- | -------- | --------------------------------------- |
| `get`     | Yes      | Retrieves a secret value by key         |
| `put`     | Yes      | Stores a secret key-value pair          |
| `list`    | Yes      | Lists all secret key names (not values) |
| `getName` | Yes      | Returns the vault instance name         |

For full interface signatures and type details, see
[references/api.md](references/api.md).

## Configuration

Configure a custom vault in `.swamp.yaml`:

```yaml
vault:
  type: "@myorg/my-vault"
  config:
    endpoint: "https://vault.example.com"
    token: "hvs.xxxxxxxxxxxx"
```

Verify with:

```bash
swamp vault status --json
```

## Development Workflow

1. **Search existing**: `swamp extension search vault` — if a match exists,
   install it and skip to step 5
2. **Create mod.ts**: Create `extensions/vaults/my-vault/mod.ts` using the Quick
   Start template above
3. **Configure**: Add the vault type and config to `.swamp.yaml`
4. **Verify**: Run `swamp vault status --json` — should show your custom type
   - If type not found, check the export name is `export const vault` and the
     file is under `extensions/vaults/`
   - After fixes, delete stale bundles and re-verify:
     ```bash
     rm -rf .swamp/vault-bundles/
     swamp vault status --json
     ```
5. **Test**: Run `swamp vault get <key>` and `swamp vault put <key> <value>` to
   confirm end-to-end functionality

## Discovery & Loading

- Location: `{repo}/extensions/vaults/**/*.ts`
- Discovery: Recursive, all `.ts` files
- Excluded: Files ending in `_test.ts`, directories starting with `_`
- Export: Files without `export const vault` are silently skipped
- Caching: Bundles are cached in `.swamp/vault-bundles/` (mtime-based)

## Key Rules

1. **Import**: `import { z } from "npm:zod@4";` — always required for config
   schemas
2. **Export name**: Must be `export const vault = { ... }`
3. **Reserved collectives**: Cannot use `swamp` or `si` in the type
4. **Type pattern**: `@collective/name` or `collective/name` (lowercase,
   alphanumeric, hyphens, underscores)
5. **Static imports only**: All npm imports must be static top-level imports —
   dynamic `import()` is not supported
6. **Pin npm versions**: Always pin versions — either inline (`npm:pkg@1.2.3`)
   or via a `deno.json` import map
7. **createProvider takes two args**:
   `(name: string, config: Record<string, unknown>)` — the first arg is the
   vault instance name, the second is the parsed config

## Extension Adversarial Review

After writing or significantly modifying vault code, and before running unit
tests, read the
[extension adversarial review](../swamp-extension-model/references/adversarial-review.md)
and self-review against all applicable dimensions (universal + vaults). Present
findings to the user before proceeding.

## Publishing

Publishing is the same for all extension types. Before pushing:

1. **Get next version**:
   `swamp extension version --manifest manifest.yaml --json`
2. **Bump version** in `manifest.yaml` — use the `nextVersion` from above
3. **Format & lint**: `swamp extension fmt manifest.yaml`
4. **Dry-run**: `swamp extension push manifest.yaml --dry-run --json`
5. **Push**: `swamp extension push manifest.yaml --yes --json`

For the full manifest schema, CalVer versioning, safety rules, and
troubleshooting, see the
[publishing guide](../swamp-extension-model/references/publishing.md).

## When to Use Other Skills

| Need                               | Use Skill                   |
| ---------------------------------- | --------------------------- |
| Use existing vaults (CLI commands) | `swamp-vault`               |
| Create custom models               | `swamp-extension-model`     |
| Create custom datastores           | `swamp-extension-datastore` |
| Create custom execution drivers    | `swamp-extension-driver`    |
| Repository setup and configuration | `swamp-repo`                |
| Understand swamp internals         | `swamp-troubleshooting`     |

## References

- **API Reference**: See [references/api.md](references/api.md) for full
  `VaultProvider` interface documentation
- **Examples**: See [references/examples.md](references/examples.md) for
  complete working examples
- **Testing**: See [references/testing.md](references/testing.md) for unit
  testing vault providers with `@systeminit/swamp-testing`
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  issues (type not found, config validation, stale bundles)
