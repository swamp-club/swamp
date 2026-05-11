# Examples — Extension Drivers

## Minimal Subprocess Driver

A driver that executes commands via a local subprocess:

```typescript
// extensions/drivers/subprocess/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  shell: z.string().default("/bin/sh"),
  timeout: z.number().positive().optional(),
});

export const driver = {
  type: "@myorg/subprocess",
  name: "Subprocess Driver",
  description: "Executes model methods as subprocess commands",
  configSchema: ConfigSchema,
  createDriver: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    return {
      type: "@myorg/subprocess",
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
        const run = request.methodArgs.run as string | undefined;

        if (!run) {
          return {
            status: "error" as const,
            error: "Subprocess driver requires a 'run' string in methodArgs",
            outputs: [],
            logs: [],
            durationMs: 0,
          };
        }

        try {
          const command = new Deno.Command(parsed.shell, {
            args: ["-c", run],
            stdout: "piped",
            stderr: "piped",
            env: {
              SWAMP_MODEL_TYPE: request.modelType,
              SWAMP_MODEL_ID: request.modelId,
              SWAMP_METHOD: request.methodName,
              ...Object.fromEntries(
                Object.entries(request.globalArgs)
                  .filter(([_, v]) => typeof v === "string")
                  .map((
                    [k, v],
                  ) => [`SWAMP_ARG_${k.toUpperCase()}`, v as string]),
              ),
            },
          });

          const process = command.spawn();
          const [stdout, stderr, status] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.status,
          ]);

          for (const line of stderr.split("\n").filter(Boolean)) {
            logs.push(line);
            callbacks?.onLog?.(line);
          }

          const durationMs = performance.now() - start;

          if (status.code !== 0) {
            return {
              status: "error" as const,
              error: stderr || `Process exited with code ${status.code}`,
              outputs: [],
              logs,
              durationMs,
            };
          }

          return {
            status: "success" as const,
            outputs: [{
              kind: "pending" as const,
              specName: request.methodName,
              name: request.methodName,
              type: "resource" as const,
              content: new TextEncoder().encode(stdout),
              metadata: {
                exitCode: status.code,
                durationMs: Math.round(durationMs),
              },
            }],
            logs,
            durationMs,
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

## Remote Execution Driver with Lifecycle

A driver that connects to a remote server, with `initialize` and `shutdown`:

```typescript
// extensions/drivers/remote-exec/mod.ts
import { z } from "npm:zod@4";

const ConfigSchema = z.object({
  host: z.string(),
  port: z.number().default(22),
  apiEndpoint: z.string().url(),
});

export const driver = {
  type: "@myorg/remote-exec",
  name: "Remote Execution Driver",
  description: "Executes model methods on a remote server via API",
  configSchema: ConfigSchema,
  createDriver: (config: Record<string, unknown>) => {
    const parsed = ConfigSchema.parse(config);
    let sessionToken: string | undefined;

    return {
      type: "@myorg/remote-exec",

      // One-time setup: establish session
      initialize: async () => {
        const res = await fetch(`${parsed.apiEndpoint}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ host: parsed.host, port: parsed.port }),
        });
        const data = await res.json();
        sessionToken = data.token;
      },

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
            `Executing ${request.methodName} on ${parsed.host}`,
          );

          const res = await fetch(`${parsed.apiEndpoint}/execute`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
              method: request.methodName,
              args: request.methodArgs,
              globalArgs: request.globalArgs,
              bundle: request.bundle
                ? btoa(String.fromCharCode(...request.bundle))
                : undefined,
            }),
          });

          const result = await res.json();
          const durationMs = performance.now() - start;

          if (!res.ok) {
            return {
              status: "error" as const,
              error: result.error || `HTTP ${res.status}`,
              outputs: [],
              logs,
              durationMs,
            };
          }

          return {
            status: "success" as const,
            outputs: [{
              kind: "pending" as const,
              specName: request.methodName,
              name: request.methodName,
              type: "resource" as const,
              content: new TextEncoder().encode(JSON.stringify(result.data)),
            }],
            logs: [...logs, ...(result.logs || [])],
            durationMs,
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

      // Cleanup: close session
      shutdown: async () => {
        if (sessionToken) {
          await fetch(`${parsed.apiEndpoint}/sessions/${sessionToken}`, {
            method: "DELETE",
          });
          sessionToken = undefined;
        }
      },
    };
  },
};
```

## YAML Configuration Examples

### Definition level

```yaml
# models/my-build.yaml
type: "@myorg/builder"
name: my-build
driver: "@myorg/remote-exec"
driverConfig:
  host: "build-server.example.com"
  port: 22
  apiEndpoint: "https://api.example.com"
globalArguments:
  project: "my-app"
```

### Workflow level

```yaml
# workflows/deploy.yaml
name: deploy
driver: docker
driverConfig:
  image: "node:20-alpine"
  memory: "1g"
jobs:
  build:
    steps:
      - method: compile
        model: my-builder
  test:
    depends_on: [build]
    steps:
      - method: run
        model: my-tests
```

### Step-level override

```yaml
jobs:
  build:
    steps:
      - method: compile
        model: my-builder
        # Override workflow-level driver for this step
        driver: "@myorg/remote-exec"
        driverConfig:
          host: "gpu-server.example.com"
          apiEndpoint: "https://api.example.com"
```

### Resolution priority

```
step > job > workflow > definition > "raw" (default)
```

The first non-undefined `driver` value wins. Config is NOT merged across levels
— the winning level's `driverConfig` is used as-is.

## Built-in Docker Driver Reference

The Docker driver (`src/domain/drivers/docker_execution_driver.ts`) supports two
modes:

- **Command mode**: `methodArgs.run` is a shell command. Stdout becomes resource
  data, stderr streams as logs.
- **Bundle mode**: A pre-compiled TypeScript bundle is mounted and executed with
  Deno inside the container.

Use the Docker driver source as a reference for implementing complex drivers
with timeout handling, process management, and output parsing.
