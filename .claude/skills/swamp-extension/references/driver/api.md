# API Reference — Extension Drivers

Full interface documentation for implementing custom execution drivers.

Source files:

- `src/domain/drivers/execution_driver.ts`
- `src/domain/drivers/docker_execution_driver.ts` (reference implementation)

## ExecutionDriver

Pluggable execution driver interface. Drivers control how model methods are
executed — in-process (raw), in a container (docker), or remotely.

```typescript
interface ExecutionDriver {
  readonly type: string;
  execute(
    request: ExecutionRequest,
    callbacks?: ExecutionCallbacks,
  ): Promise<ExecutionResult>;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}
```

### `type`

Readonly property identifying the driver type. Must match the `type` field in
the driver export.

### `execute(request, callbacks?)`

Execute a model method. This is the core method — receives the full execution
context and returns results.

### `initialize()?`

Optional one-time setup. Called before the first `execute()` invocation. Use for
expensive setup like pulling Docker images or establishing connections.

### `shutdown()?`

Optional cleanup. Called when the driver is no longer needed. Use for closing
connections, stopping containers, etc.

## ExecutionRequest

Serializable request envelope sent to a driver.

```typescript
interface ExecutionRequest {
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
  resourceSpecs?: Record<string, unknown>;
  fileSpecs?: Record<string, unknown>;
  bundle?: Uint8Array;
}
```

### Fields

| Field             | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `protocolVersion` | Protocol version for forward compatibility             |
| `modelType`       | The model type identifier                              |
| `modelId`         | The model/definition ID                                |
| `methodName`      | The method name to execute                             |
| `globalArgs`      | Pre-validated global arguments from the definition     |
| `methodArgs`      | Pre-validated per-method arguments                     |
| `definitionMeta`  | Definition metadata (id, name, version, tags)          |
| `resourceSpecs`   | Resource output spec metadata (optional)               |
| `fileSpecs`       | File output spec metadata (optional)                   |
| `bundle`          | Bundled TypeScript module for out-of-process execution |

The `bundle` field is populated when the model has been bundled for
out-of-process execution. Drivers can use this to send the code to a remote
runtime (e.g., Docker container, Lambda function).

## ExecutionCallbacks

Real-time event callbacks during execution.

```typescript
interface ExecutionCallbacks {
  onLog?: (line: string) => void;
  onResourceWritten?: (handle: DataHandle) => void;
}
```

### `onLog(line)`

Called when a log line is emitted during execution. Use this to stream real-time
output to the user.

### `onResourceWritten(handle)`

Called when a resource is written during execution. Only used by in-process
drivers that write data directly.

## ExecutionResult

Result returned by a driver after execution.

```typescript
interface ExecutionResult {
  status: "success" | "error";
  error?: string;
  outputs: DriverOutput[];
  logs: string[];
  durationMs: number;
  followUpActions?: unknown[];
}
```

### Fields

| Field             | Description                                   |
| ----------------- | --------------------------------------------- |
| `status`          | `"success"` or `"error"`                      |
| `error`           | Error message (when status is `"error"`)      |
| `outputs`         | Array of `DriverOutput` (resources and files) |
| `logs`            | Log lines captured during execution           |
| `durationMs`      | Execution duration in milliseconds            |
| `followUpActions` | Follow-up actions (in-process drivers only)   |

## DriverOutput

Discriminated union for driver outputs.

```typescript
type DriverOutput =
  | { kind: "persisted"; handle: DataHandle }
  | {
    kind: "pending";
    specName: string;
    name: string;
    type: "resource" | "file";
    content: Uint8Array;
    tags?: Record<string, string>;
    metadata?: Record<string, unknown>;
  };
```

### `"persisted"` outputs

Data was already written in-process. The `handle` references existing data in
the datastore. Only used by in-process drivers (like `raw`).

### `"pending"` outputs

Data needs to be persisted by swamp after the driver returns. This is the
standard output type for out-of-process drivers.

| Field      | Description                                        |
| ---------- | -------------------------------------------------- |
| `specName` | Output spec name (from model resources/files)      |
| `name`     | Instance name for this output                      |
| `type`     | `"resource"` (JSON data) or `"file"` (binary/text) |
| `content`  | Raw content as `Uint8Array`                        |
| `tags`     | Optional key-value tags                            |
| `metadata` | Execution metadata (exit code, timing, etc.)       |

## Docker Driver Config (Reference)

The built-in Docker driver's config schema is a useful reference for designing
driver configuration:

```typescript
const DockerDriverConfigSchema = z.object({
  image: z.string().min(1), // Required: Docker image
  bundleImage: z.string().optional(), // Image for bundle mode
  command: z.string().default("docker"), // docker, podman, nerdctl
  timeout: z.number().positive().optional(),
  network: z.string().optional(),
  memory: z.string().optional(), // e.g., "512m"
  cpus: z.string().optional(), // e.g., "1.5"
  volumes: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
});
```

See `src/domain/drivers/docker_execution_driver.ts` for the full implementation.
