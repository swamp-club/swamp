---
name: swamp-extension-driver
description: Create user-defined TypeScript execution drivers for swamp — implement ExecutionDriver to control where and how model methods run. Use when users want custom execution environments (remote servers, cloud functions, custom containers). Triggers on "custom driver", "extension driver", "execution driver", "ExecutionDriver", "extensions/drivers", "create driver", "new driver type", "driver plugin", "remote execution", "driver implementation".
---

# Swamp Extension Driver

Create TypeScript execution drivers in `extensions/drivers/` that swamp loads at
startup.

## When to Create a Custom Driver

**Create an extension driver when the built-in drivers (raw, docker) don't meet
your execution needs.**

Drivers control _where and how_ model methods execute, not _what_ they do:

- `raw` — in-process execution (default)
- `docker` — isolated Docker container execution
- Custom — SSH, Lambda, Kubernetes, cloud functions, etc.

Before creating a custom driver:

1. Built-in drivers: `raw` (in-process), `docker` (container isolation)
2. Search community: `swamp extension search driver`
3. If a community extension exists, install it instead
4. Only create a custom driver if nothing fits

Extensions from trusted collectives (`@swamp/*`, `@si/*`, and your membership
collectives) auto-resolve on first use. Use `swamp extension trust list` to see
which collectives are trusted.

## Quick Reference

| Task                | Command/Action                                 |
| ------------------- | ---------------------------------------------- |
| Search community    | `swamp extension search driver --json`         |
| Create driver file  | Create `extensions/drivers/my-driver/mod.ts`   |
| Verify registration | `swamp model type search --json`               |
| Push extension      | `swamp extension push manifest.yaml --json`    |
| Dry-run push        | `swamp extension push manifest.yaml --dry-run` |

## Quick Start

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

1. Check registration: `swamp model type search --json` — your driver type
   should be loadable
2. Test with a model: create a definition with `driver: "@myorg/my-driver"` and
   run a method
3. If the driver isn't found, delete stale bundles and retry:

```bash
rm -rf .swamp/driver-bundles/
swamp model method run my-instance run --json
```

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
6. **Pin npm versions**: Always pin versions (e.g., `npm:pkg@1.2.3`) except
   `npm:zod@4`
7. **Output types**: Drivers return `"pending"` outputs (data to be persisted by
   swamp) or `"persisted"` outputs (already written by in-process drivers)

## When to Use Other Skills

| Need                              | Use Skill                   |
| --------------------------------- | --------------------------- |
| Create custom models              | `swamp-extension-model`     |
| Create custom datastores          | `swamp-extension-datastore` |
| Create/run workflows with drivers | `swamp-workflow`            |
| Repository setup                  | `swamp-repo`                |

## References

- **API Reference**: See [references/api.md](references/api.md) for full
  `ExecutionDriver`, `ExecutionRequest`, `ExecutionCallbacks`,
  `ExecutionResult`, and `DriverOutput` interface documentation
- **Examples**: See [references/examples.md](references/examples.md) for
  complete working examples (subprocess, remote execution, Docker reference)
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  issues (driver not found, output types, resolution priority)
