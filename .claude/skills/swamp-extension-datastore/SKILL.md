---
name: swamp-extension-datastore
description: Create user-defined TypeScript datastores for swamp — implement DatastoreProvider, configure locking, health checks, and optional sync. Use when users want to extend swamp with custom datastore backends. Triggers on "custom datastore", "extension datastore", "DatastoreProvider", "extensions/datastores", "create datastore", "new datastore type", "datastore plugin", "datastore implementation".
---

# Swamp Extension Datastore

Create TypeScript datastores in `extensions/datastores/` that swamp loads at
startup.

## When to Create a Custom Datastore

**Create an extension datastore when the built-in backends (filesystem, S3)
don't meet your needs.**

Before creating a custom datastore, check what's available:

1. Built-in types: `filesystem` (local directory), `s3` (AWS S3 bucket)
2. Search community extensions: `swamp extension search datastore`
3. If a community extension exists, install it instead of building from scratch
4. Only create a custom datastore if nothing fits

Extensions from trusted collectives (`@swamp/*`, `@si/*`, and your membership
collectives) auto-resolve on first use — no manual `extension pull` needed. Use
`swamp extension trust list` to see which collectives are trusted. For local or
private extensions, use `swamp extension source add <path>` to load them without
publishing (see `swamp-repo` skill).

Custom datastores let you:

- Store runtime data in any backend (GCS, Azure Blob, databases, etc.)
- Implement custom locking strategies
- Add custom sync logic for remote datastores

## Quick Reference

| Task                | Command/Action                                 |
| ------------------- | ---------------------------------------------- |
| Search community    | `swamp extension search datastore --json`      |
| Create datastore    | Create `extensions/datastores/my-store/mod.ts` |
| Verify registration | `swamp datastore status --json`                |
| Check config        | View `.swamp.yaml` datastore section           |
| Push extension      | `swamp extension push manifest.yaml --json`    |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run` |

## Quick Start

```typescript
// extensions/datastores/my-store/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  endpoint: z.string().url(),
  bucket: z.string(),
});

export const datastore = {
  type: "@myorg/my-store",
  name: "My Custom Store",
  description: "Stores runtime data in a custom backend",
  configSchema: ConfigSchema,
  createProvider: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    return {
      createLock: (
        datastorePath: string,
        options?: {
          lockKey?: string;
          ttlMs?: number;
          retryIntervalMs?: number;
          maxWaitMs?: number;
        },
      ) => ({
        acquire: async () => {/* acquire lock */},
        release: async () => {/* release lock */},
        withLock: async <T>(fn: () => Promise<T>) => {
          // acquire, run fn, release
          return await fn();
        },
        inspect: async () => null,
        forceRelease: async (_nonce: string) => false,
      }),
      createVerifier: () => ({
        verify: async () => ({
          healthy: true,
          message: "OK",
          latencyMs: 1,
          datastoreType: "@myorg/my-store",
        }),
      }),
      resolveDatastorePath: (repoDir: string) => `${repoDir}/.my-store`,
    };
  },
};
```

## Export Contract

| Field            | Required | Description                                         |
| ---------------- | -------- | --------------------------------------------------- |
| `type`           | Yes      | Namespaced identifier (`@collective/name`)          |
| `name`           | Yes      | Human-readable display name                         |
| `description`    | Yes      | What this datastore does                            |
| `configSchema`   | No       | Zod schema for validating config from `.swamp.yaml` |
| `createProvider` | Yes      | Factory function `(config) => DatastoreProvider`    |

The `type` must match the pattern `@collective/name` or `collective/name` (e.g.,
`@myorg/custom-store`). Reserved collectives (`swamp`, `si`) cannot be used.

## DatastoreProvider Methods

| Method                 | Required | Description                                         |
| ---------------------- | -------- | --------------------------------------------------- |
| `createLock`           | Yes      | Returns a `DistributedLock` for write serialization |
| `createVerifier`       | Yes      | Returns a `DatastoreVerifier` for health checks     |
| `createSyncService`    | No       | Returns a `DatastoreSyncService` for remote sync    |
| `resolveDatastorePath` | Yes      | Returns the absolute path for runtime data storage  |
| `resolveCachePath`     | No       | Returns a local cache path for remote datastores    |

For full interface signatures and type details, see
[references/api.md](references/api.md).

## Configuration

Configure a custom datastore in `.swamp.yaml`:

```yaml
datastore:
  type: "@myorg/my-store"
  config:
    endpoint: "https://storage.example.com"
    bucket: "my-data"
```

Or via environment variable (JSON config after the type):

```bash
export SWAMP_DATASTORE='@myorg/my-store:{"endpoint":"https://storage.example.com","bucket":"my-data"}'
```

Verify with:

```bash
swamp datastore status --json
```

**Priority order:** `SWAMP_DATASTORE` env var > CLI `--datastore` arg >
`.swamp.yaml` config > default filesystem.

## Development Workflow

1. **Search existing**: `swamp extension search datastore` — if a match exists,
   install it and skip to step 5
2. **Create mod.ts**: Create `extensions/datastores/my-store/mod.ts` using the
   Quick Start template above
3. **Configure**: Add the datastore type and config to `.swamp.yaml` (or set
   `SWAMP_DATASTORE` env var)
4. **Verify**: Run `swamp datastore status --json` — should show your custom
   type with `healthy: true`
   - If `healthy: false`, check the error message and fix your
     `createVerifier().verify()` implementation
   - If type not found, check the export name is `export const datastore` and
     the file is under `extensions/datastores/`
   - After fixes, delete stale bundles and re-verify:
     ```bash
     rm -rf .swamp/datastore-bundles/
     swamp datastore status --json
     ```
5. **Test**: Run a model operation that uses the datastore to confirm end-to-end
   functionality

## Discovery & Loading

- Location: `{repo}/extensions/datastores/**/*.ts`
- Discovery: Recursive, all `.ts` files
- Excluded: Files ending in `_test.ts`
- Export: Files without `export const datastore` are silently skipped
- Caching: Bundles are cached in `.swamp/datastore-bundles/` (mtime-based)

## Key Rules

1. **Import**: `import { z } from "npm:zod@4";` — always required for config
   schemas
2. **Export name**: Must be `export const datastore = { ... }`
3. **Reserved collectives**: Cannot use `swamp` or `si` in the type
4. **Type pattern**: `@collective/name` or `collective/name` (lowercase,
   alphanumeric, hyphens, underscores)
5. **Static imports only**: All npm imports must be static top-level imports —
   dynamic `import()` is not supported
6. **Pin npm versions**: Always pin versions — either inline (`npm:pkg@1.2.3`),
   via a `deno.json` import map, or in `package.json`
7. **Locking is required**: `createLock` must return a working `DistributedLock`
   — swamp acquires locks for all write operations

## Extension Adversarial Review

After writing or significantly modifying datastore code, and before running unit
tests, read the
[extension adversarial review](../swamp-extension-model/references/adversarial-review.md)
and self-review against all applicable dimensions (universal + datastores).
Present findings to the user before proceeding.

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

| Need                                | Use Skill                |
| ----------------------------------- | ------------------------ |
| Use existing datastores             | `swamp-repo`             |
| Create custom models                | `swamp-extension-model`  |
| Create custom execution drivers     | `swamp-extension-driver` |
| Repository setup and configuration  | `swamp-repo`             |
| Manage secrets for datastore config | `swamp-vault`            |
| Understand swamp internals          | `swamp-troubleshooting`  |

## References

- **API Reference**: See [references/api.md](references/api.md) for full
  `DatastoreProvider`, `DistributedLock`, `DatastoreVerifier`, and
  `DatastoreSyncService` interface documentation
- **Examples**: See [references/examples.md](references/examples.md) for
  complete working examples (local and remote datastores)
- **Testing**: See [references/testing.md](references/testing.md) for unit
  testing datastore providers with `@systeminit/swamp-testing`
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  issues (type not found, config validation, stale bundles)
