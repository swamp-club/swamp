---
name: swamp-extension-driver
description: Create user-defined TypeScript execution drivers for swamp — implement ExecutionDriver to control where and how model methods run. Use when users want custom execution environments (remote servers, cloud functions, custom containers). Triggers on "custom driver", "extension driver", "execution driver", "ExecutionDriver", "extensions/drivers", "create driver", "new driver type", "driver plugin", "remote execution", "driver implementation".
---

# Swamp Extension Driver

Create TypeScript execution drivers in `extensions/drivers/` that swamp loads at
startup.

## Quick Reference

| Task                | Command/Action                                 |
| ------------------- | ---------------------------------------------- |
| Search community    | `swamp extension search driver --json`         |
| Create driver file  | Create `extensions/drivers/my-driver/mod.ts`   |
| Verify registration | `swamp model type search --json`               |
| Push extension      | `swamp extension push manifest.yaml --json`    |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run` |

## Quick Start

1. Create the driver file:

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
  description: "Executes model methods on a remote host via SSH",
  configSchema: ConfigSchema,
  createDriver: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    return {
      type: "@myorg/my-driver",
      execute: async (request: {
        protocolVersion: number;
        modelType: string;
        modelId: string;
        methodName: string;
        globalArgs: Record<string, unknown>;
        methodArgs: Record<string, unknown>;
        definitionMeta: {
          id: string;
          name: string;
          version: number;
          tags: Record<string, string>;
        };
        bundle?: Uint8Array;
      }, callbacks?: { onLog?: (line: string) => void }) => {
        const start = performance.now();
        const logs: string[] = [];

        try {
          callbacks?.onLog?.(
            `Executing ${request.methodName} on ${parsed.host}:${parsed.port}`,
          );
          logs.push(`Connected to ${parsed.host}`);

          // Your execution logic here
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
            logs,
            durationMs: performance.now() - start,
          };
        } catch (error) {
          return {
            status: "error" as const,
            error: String(error),
            outputs: [],
            logs,
            durationMs: performance.now() - start,
          };
        }
      },
    };
  },
};
```

2. Verify it loaded: `swamp model type search --json` — your driver type should
   appear in the output. If it doesn't, see [Verify](#verify) below.

3. Test with a model: create a definition with `driver: "@myorg/my-driver"` and
   run a method to confirm end-to-end execution.

## Export Contract

| Field          | Required | Description                                    |
| -------------- | -------- | ---------------------------------------------- |
| `type`         | Yes      | Namespaced identifier (`@collective/name`)     |
| `name`         | Yes      | Human-readable display name                    |
| `description`  | Yes      | What this driver does                          |
| `configSchema` | No       | Zod schema for validating driver config        |
| `createDriver` | Yes      | Factory function `(config) => ExecutionDriver` |

The `type` must match the pattern `@collective/name` or `collective/name`.
Reserved collectives (`swamp`, `si`) cannot be used.

## ExecutionDriver Methods

| Method       | Required | Description                                      |
| ------------ | -------- | ------------------------------------------------ |
| `type`       | Yes      | The driver type identifier (readonly property)   |
| `execute`    | Yes      | Execute a model method and return results        |
| `initialize` | No       | One-time setup (e.g., pull Docker image)         |
| `shutdown`   | No       | Cleanup (e.g., stop container, close connection) |

For full interface signatures (`ExecutionRequest`, `ExecutionCallbacks`,
`ExecutionResult`, `DriverOutput`), see [references/api.md](references/api.md).

## Using Drivers

Set the `driver` field in YAML definitions, workflows, or steps:

### Definition level (applies to all methods)

```yaml
# models/my-model.yaml
type: "@myorg/my-model"
name: my-instance
driver: "@myorg/my-driver"
driverConfig:
  host: "build-server.example.com"
  port: 22
```

### Workflow level (applies to all jobs/steps)

```yaml
# workflows/deploy.yaml
name: deploy
driver: docker
driverConfig:
  image: "node:20-alpine"
jobs:
  build:
    steps:
      - method: run
        model: my-builder
```

### Step level (overrides workflow/definition)

```yaml
jobs:
  build:
    steps:
      - method: run
        model: my-builder
        driver: "@myorg/my-driver"
        driverConfig:
          host: "gpu-server.example.com"
```

### Resolution priority

```
step > job > workflow > definition > "raw" (default)
```

The first non-undefined `driver` value wins. Its `driverConfig` is used as-is —
no merging across levels.

## Verify

After creating your driver:

1. Check registration: `swamp model type search --json` — look for your driver
   type in the output. If it appears, the driver loaded successfully.
2. Test with a model: create a definition with `driver: "@myorg/my-driver"` and
   run a method. A `"status": "success"` in the output confirms end-to-end
   execution works.
3. If the driver doesn't appear in step 1 or the method fails in step 2, delete
   stale bundles and retry:

```bash
rm -rf .swamp/driver-bundles/
swamp model method run my-instance run
```

If it still fails after clearing bundles, check for TypeScript errors in your
driver file — swamp silently skips files that fail to compile.

## Discovery & Loading

- Location: `{repo}/extensions/drivers/**/*.ts`
- Discovery: Recursive, all `.ts` files
- Excluded: Files ending in `_test.ts`
- Export: Files without `export const driver` are silently skipped
- Caching: Bundles are cached in `.swamp/driver-bundles/` (mtime-based)

## Key Rules

1. **Import**: `import { z } from "npm:zod@4";` — always required for config
   schemas
2. **Export name**: Must be `export const driver = { ... }`
3. **Reserved collectives**: Cannot use `swamp` or `si` in the type
4. **Type pattern**: `@collective/name` or `collective/name` (lowercase,
   alphanumeric, hyphens, underscores)
5. **Static imports only**: All npm imports must be static top-level imports —
   dynamic `import()` is not supported
6. **Pin npm versions**: Always pin versions — either inline (`npm:pkg@1.2.3`),
   via a `deno.json` import map, or in `package.json`
7. **Output types**: Drivers return `"pending"` outputs (data to be persisted by
   swamp) or `"persisted"` outputs (already written by in-process drivers)

## Extension Adversarial Review

After writing or significantly modifying driver code, and before running unit
tests, read the
[extension adversarial review](../swamp-extension-model/references/adversarial-review.md)
and self-review against all applicable dimensions (universal + drivers). Present
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

## References

- **API Reference**: See [references/api.md](references/api.md) for full
  `ExecutionDriver`, `ExecutionRequest`, `ExecutionCallbacks`,
  `ExecutionResult`, and `DriverOutput` interface documentation
- **Examples**: See [references/examples.md](references/examples.md) for
  complete working examples (subprocess, remote execution, Docker reference)
- **Testing**: See [references/testing.md](references/testing.md) for unit
  testing execution drivers with `@systeminit/swamp-testing`
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  issues (driver not found, output types, resolution priority)

## When to Use Other Skills

| Need                       | Use Skill               |
| -------------------------- | ----------------------- |
| Use existing models        | `swamp-model`           |
| Create custom models       | `swamp-extension-model` |
| Repository structure       | `swamp-repo`            |
| Understand swamp internals | `swamp-troubleshooting` |
