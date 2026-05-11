---
name: swamp-extension
description: >
  Create, test, and develop swamp extensions — models, vaults, drivers,
  datastores, and reports. Covers Zod schemas, smoke testing, manifest.yaml,
  and the quality scorecard. Do NOT use for running existing models
  (swamp-model), using vaults (swamp-vault), workflows (swamp-workflow),
  debugging (swamp-troubleshooting), or publishing (swamp-extension-publish).
  Triggers on "create model", "custom model", "extension model", "zod schema",
  "build integration", "extensions/models", "implement model", "smoke test
  extension", "test extension", "manifest.yaml", "custom vault", "VaultProvider",
  "extensions/vaults", "custom driver", "ExecutionDriver", "extensions/drivers",
  "custom datastore", "DatastoreProvider", "extensions/datastores", "create
  report extension", "extensions/reports", "quality score", "scorecard",
  "improve my extension", "extension quality", "rubric", "fast-check",
  "extension grade", "symbols-docs".
---

# Swamp Extension

Create TypeScript extensions that swamp loads at startup. Five extension types
share the same workflow: implement an interface, register in a manifest, publish
via `swamp-extension-publish`.

## Determine Extension Type

| User intent                                    | Type      | Export                   | Location                         |
| ---------------------------------------------- | --------- | ------------------------ | -------------------------------- |
| New data source, API integration, automation   | Model     | `export const model`     | `extensions/models/*.ts`         |
| Custom secret backend (HashiCorp Vault, 1P, …) | Vault     | `export const vault`     | `extensions/vaults/*/mod.ts`     |
| Control where/how model methods execute        | Driver    | `export const driver`    | `extensions/drivers/*/mod.ts`    |
| Custom storage backend (GCS, DB, …)            | Datastore | `export const datastore` | `extensions/datastores/*/mod.ts` |
| Repeatable analysis of model/workflow output   | Report    | `export const report`    | `extensions/reports/*.ts`        |

## Before Creating an Extension

1. `swamp model type search <query>` / `swamp extension search <query>` — does a
   built-in or community extension already cover it? Use it. Stop.
2. Trusted collectives (`@swamp/*`, `@si/*`, membership collectives)
   auto-resolve on first use — `swamp extension trust list` shows which.
3. For local or private extensions, use `swamp extension source add <path>`.
4. Only create a new extension if nothing fits.

**Never** use `command/shell` to wrap service integrations — build a dedicated
model.

## Choosing a Collective Name

Run `swamp auth whoami --json` to see available collectives. If multiple are
returned, **always ask the user** which one to use. Use `@collective/name` from
the start — placeholder prefixes like `@local/` are rejected during push.

## Quick Reference

| Task                | Command/Action                                 |
| ------------------- | ---------------------------------------------- |
| Search community    | `swamp extension search <query> --json`        |
| Verify registration | `swamp model type search --json`               |
| Verify it loads     | `swamp doctor extensions --json`               |
| Inspect catalog     | `swamp doctor extensions --verbose`            |
| Repair stale state  | `swamp doctor extensions --repair`             |
| Next version        | `swamp extension version --manifest m.yaml -j` |
| Create manifest     | Create `manifest.yaml` with extension entries  |
| Format extension    | `swamp extension fmt manifest.yaml --json`     |
| Check formatting    | `swamp extension fmt manifest.yaml --check -j` |
| Quality score       | `swamp extension quality manifest.yaml --json` |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run` |
| Push extension      | `swamp extension push manifest.yaml --json`    |

## Quick Starts

### Model

```typescript
// extensions/models/my_model.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  message: z.string(),
});

const OutputSchema = z.object({
  id: z.uuid(),
  message: z.string(),
  timestamp: z.iso.datetime(),
});

export const model = {
  type: "@myorg/my-model",
  version: "2026.02.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "result": {
      description: "Model output data",
      schema: OutputSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Process the input message",
      arguments: z.object({}),
      execute: async (args, context) => {
        const handle = await context.writeResource("result", "main", {
          id: crypto.randomUUID(),
          message: context.globalArgs.message.toUpperCase(),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

### Vault

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
    return {
      get: async (key: string) => {
        /* fetch from backend */ return "";
      },
      put: async (key: string, value: string) => {/* store */},
      list: async () => {
        /* list keys */ return [];
      },
      getName: () => name,
    };
  },
};
```

### Driver

```typescript
// extensions/drivers/my-driver/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  host: z.string(),
  port: z.number().default(22),
});

export const driver = {
  type: "@myorg/my-driver",
  name: "My Custom Driver",
  description: "Executes methods on a remote host",
  configSchema: ConfigSchema,
  createDriver: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    return {
      type: "@myorg/my-driver",
      execute: async (request, callbacks?) => {
        callbacks?.onLog?.(`Executing ${request.methodName} on ${parsed.host}`);
        const output = new TextEncoder().encode(
          JSON.stringify({ result: "ok" }),
        );
        return {
          status: "success" as const,
          outputs: [{
            kind: "pending" as const,
            specName: request.methodName,
            name: request.methodName,
            type: "resource" as const,
            content: output,
          }],
          logs: [],
          durationMs: 0,
        };
      },
    };
  },
};
```

### Datastore

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
      createLock: (path, opts?) => ({
        acquire: async () => {},
        release: async () => {},
        withLock: async <T>(fn: () => Promise<T>) => fn(),
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

## Shared Development Workflow

All extension types follow the same lifecycle:

1. **Confirm nothing covers it** — search built-in and community first.
2. **Author the extension file** — use the Quick Start above; `deno check`.
3. **Verify registration** — `swamp model type search --json` (models/drivers)
   or `swamp vault status --json` / `swamp datastore status --json`.
4. **Adversarial review** — see
   [Adversarial Review Gate](#adversarial-review-gate) below.
5. **Smoke test** (models) — see
   [references/model/smoke_testing.md](references/model/smoke_testing.md).
6. **Unit tests** — colocate `*_test.ts`; `deno test` passes.
7. **Version + manifest** — `swamp extension version`,
   `swamp extension fmt manifest.yaml --check`.
8. **Quality check** (optional) — `swamp extension quality manifest.yaml`.
9. **Publish** — use the `swamp-extension-publish` skill.

### Adversarial Review Gate

> **STOP — do not skip.**
>
> After authoring or **significantly modifying** extension code, and BEFORE
> running smoke tests or unit tests:
>
> 1. Read [references/adversarial-review.md](references/adversarial-review.md)
>    and self-review against every applicable dimension.
> 2. Produce the structured findings report described in that file.
> 3. Present the report to the user and wait for acknowledgement.

## Key Rules (All Types)

1. **Import**: `import { z } from "npm:zod@4";` — always required
2. **Static imports only**: Dynamic `import()` is rejected during push
3. **Pin npm versions**: Always pin — inline, via `deno.json`, or `package.json`
4. **Reserved collectives**: Cannot use `swamp` or `si` in the type
5. **Type pattern**: `@collective/name` (lowercase, alphanumeric, hyphens,
   underscores)

## Discovery & Loading

| Type      | Location                        | Export name              | Bundle cache                |
| --------- | ------------------------------- | ------------------------ | --------------------------- |
| Model     | `extensions/models/**/*.ts`     | `export const model`     | (bundled inline)            |
| Vault     | `extensions/vaults/**/*.ts`     | `export const vault`     | `.swamp/vault-bundles/`     |
| Driver    | `extensions/drivers/**/*.ts`    | `export const driver`    | `.swamp/driver-bundles/`    |
| Datastore | `extensions/datastores/**/*.ts` | `export const datastore` | `.swamp/datastore-bundles/` |
| Report    | `extensions/reports/*.ts`       | `export const report`    | (bundled inline)            |

Files ending in `_test.ts` are excluded. Files without the correct export are
silently skipped. When a file fails to load, swamp emits `swamp-warning:` on
stderr.

If an extension doesn't appear after creation, delete stale bundles
(`rm -rf .swamp/<type>-bundles/`) and retry.

## Quality Scorecard

Swamp Club scores published extensions against an 11-factor rubric. Maximum
third-party score: **12/13 = 92% (Grade A)**.

Key factors: README in `additionalFiles:`, LICENSE file, JSDoc coverage ≥80%,
explicit return types, manifest `description:`, `repository:` URL on allowlisted
host.

Run `swamp extension quality manifest.yaml --json` for a local self-check.

See [references/quality/rubric.md](references/quality/rubric.md) for the full
rubric and [references/quality/templates.md](references/quality/templates.md)
for manifest/README skeletons.

## Model-Specific

Models have the richest API surface. For model-specific guidance:

- **Model structure** (fields, resources, files, methods, checks, upgrades):
  detailed in [references/model/api.md](references/model/api.md)
- **Pre-flight checks**:
  [references/model/checks.md](references/model/checks.md)
- **Execute function** (`context.writeResource`, `readResource`,
  `createFileWriter`, `dataRepository`, `extensionFile`):
  [references/model/api.md](references/model/api.md)
- **Factory models**: multiple outputs from one spec —
  [references/model/scenarios.md](references/model/scenarios.md#scenario-3-factory-model-for-discovery)
- **CRUD lifecycle**: create/update/delete/sync patterns —
  [references/model/examples.md](references/model/examples.md#crud-lifecycle-model-vpc)
- **Extending existing types**: `export const extension` —
  [references/model/api.md](references/model/api.md)
- **Version upgrades**:
  [references/model/upgrades.md](references/model/upgrades.md)
- **Smoke testing**:
  [references/model/smoke_testing.md](references/model/smoke_testing.md)
- **Docker execution**:
  [references/model/docker-execution.md](references/model/docker-execution.md)
- **Typing**: [references/model/typing.md](references/model/typing.md)
- **Bundling skills**: [references/model/skills.md](references/model/skills.md)
- **Examples**: [references/model/examples.md](references/model/examples.md)
- **Scenarios**: [references/model/scenarios.md](references/model/scenarios.md)
- **Troubleshooting**:
  [references/model/troubleshooting.md](references/model/troubleshooting.md)

## Vault-Specific

- **VaultProvider interface** (`get`, `put`, `list`, `getName`):
  [references/vault/api.md](references/vault/api.md)
- **Configuration** in `.swamp.yaml`:
  [references/vault/api.md](references/vault/api.md)
- **Examples**: [references/vault/examples.md](references/vault/examples.md)
- **Testing**: [references/vault/testing.md](references/vault/testing.md)
- **Troubleshooting**:
  [references/vault/troubleshooting.md](references/vault/troubleshooting.md)

Note: `createProvider` takes two args: `(name: string, config)` — the first is
the vault instance name, the second is the parsed config.

## Driver-Specific

- **ExecutionDriver interface** (`execute`, `initialize`, `shutdown`):
  [references/driver/api.md](references/driver/api.md)
- **Resolution priority**: step > job > workflow > definition > "raw" (default)
- **Examples**: [references/driver/examples.md](references/driver/examples.md)
- **Testing**: [references/driver/testing.md](references/driver/testing.md)
- **Troubleshooting**:
  [references/driver/troubleshooting.md](references/driver/troubleshooting.md)

## Datastore-Specific

- **DatastoreProvider interface** (`createLock`, `createVerifier`,
  `resolveDatastorePath`, optional `createSyncService`):
  [references/datastore/api.md](references/datastore/api.md)
- **Configuration** in `.swamp.yaml` or `SWAMP_DATASTORE` env var
- **Examples**:
  [references/datastore/examples.md](references/datastore/examples.md)
- **Testing**:
  [references/datastore/testing.md](references/datastore/testing.md)
- **Troubleshooting**:
  [references/datastore/troubleshooting.md](references/datastore/troubleshooting.md)

## Report-Specific

For creating report extensions, see
[references/report/api.md](references/report/api.md).

## Manifest Path Resolution

All extension types support the optional `paths.base` manifest field. Default
behavior is unchanged — omit it and paths resolve relative to the configured
`extensions/<type>/` directory. Set `paths.base: manifest` for
per-extension-subdir layouts. See
[swamp-extension-publish references/publishing.md](../swamp-extension-publish/references/publishing.md#path-resolution--pathsbase).

## CalVer Versioning

Use `swamp extension version --manifest manifest.yaml --json` to get the correct
next version. See
[publishing reference](../swamp-extension-publish/references/publishing.md#calver-versioning).

## When to Use Other Skills

| Need                       | Use Skill                 |
| -------------------------- | ------------------------- |
| Use existing models        | `swamp-model`             |
| Use existing vaults        | `swamp-vault`             |
| Create/run workflows       | `swamp-workflow`          |
| Manage model data          | `swamp-data`              |
| Repository setup           | `swamp-repo`              |
| Run/configure reports      | `swamp-report`            |
| Publish extensions         | `swamp-extension-publish` |
| Debug runtime errors       | `swamp-troubleshooting`   |
| Understand swamp internals | `swamp-troubleshooting`   |
