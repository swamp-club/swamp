# Execution Drivers

An execution driver in swamp controls where and how a model method runs. The
default driver (`raw`) runs methods directly in the host Deno process. The
`docker` driver runs methods in isolated containers.

## Built-in Drivers

### Raw

The default driver. Executes model methods directly in the host Deno process
with full access to the data repository, vault service, and file system. Data
written via `writeResource` and `createFileWriter` is persisted immediately
in-process.

### Docker

Runs model methods in isolated Docker containers. Supports two execution modes
that are auto-detected based on the method's arguments and available bundle:

- **Command mode** — when `methodArgs.run` is a non-empty string, the driver
  runs `sh -c "<command>"` inside the container. Stdout becomes resource data;
  stderr streams as real-time logs.
- **Bundle mode** — when `request.bundle` exists (extension models), the driver
  mounts a self-contained JavaScript bundle, a request JSON payload, and a
  runner script into `/swamp/`. The container executes
  `deno run --allow-all /swamp/runner.js`.

## Configuration

### Resolution Priority

Driver config is resolved from multiple sources (highest priority first):

1. CLI `--driver` flag
2. Workflow step `driver:` field
3. Workflow job `driver:` field
4. Workflow-level `driver:` field
5. Model definition `driver:` field
6. Default: `raw`

The first non-undefined `driver` value wins. Its corresponding `driverConfig` is
used as-is — configs are **not** merged across levels.

### CLI Override

```bash
swamp model method run my-model execute --driver docker
swamp workflow run my-workflow --driver docker
```

### Definition YAML

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-model
version: 1
driver: docker
driverConfig:
  image: "alpine:latest"
  timeout: 30000
methods:
  execute:
    arguments:
      run: "echo hello"
```

### Using Podman or nerdctl

Set `command` in `driverConfig` to use an alternative container runtime:

```yaml
driver: docker
driverConfig:
  command: "podman"
  image: "alpine:latest"
```

### Workflow YAML

Driver can be set at the workflow, job, or step level:

```yaml
id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
name: my-workflow
version: 1
driver: docker
driverConfig:
  image: "alpine:latest"
jobs:
  - name: build
    steps:
      - name: compile
        driver: raw # Override: run this step in-process
        task:
          type: model_method
          modelIdOrName: compiler
          methodName: run
      - name: test
        driver: docker
        driverConfig:
          image: "node:20-alpine"
          memory: "1g"
        task:
          type: model_method
          modelIdOrName: tester
          methodName: run
```

## Docker Driver

### Configuration Schema

| Field         | Type                     | Required | Description                                                    |
| ------------- | ------------------------ | -------- | -------------------------------------------------------------- |
| `image`       | `string`                 | Yes      | Docker image to run                                            |
| `bundleImage` | `string`                 | No       | Image for bundle mode (must have Deno); defaults to `image`    |
| `command`     | `string`                 | No       | CLI binary — `docker`, `podman`, `nerdctl` (default: `docker`) |
| `timeout`     | `number`                 | No       | Timeout in milliseconds                                        |
| `network`     | `string`                 | No       | Docker network to attach                                       |
| `memory`      | `string`                 | No       | Memory limit (e.g. `512m`)                                     |
| `cpus`        | `string`                 | No       | CPU limit (e.g. `1.5`)                                         |
| `volumes`     | `string[]`               | No       | Volume mounts (e.g. `["/host:/container"]`)                    |
| `env`         | `Record<string, string>` | No       | Environment variables                                          |
| `extraArgs`   | `string[]`               | No       | Additional docker run flags                                    |

### Mode Detection

```
Has request.bundle?  ──yes──▶  Bundle mode
       │
      no
       │
Has methodArgs.run?  ──yes──▶  Command mode
       │
      no
       │
    Error: "Docker driver requires either a bundle or a 'run' string"
```

### Command Mode

1. Build `docker run` args from config (network, memory, cpus, volumes, env)
2. Append image and `sh -c "<command>"`
3. Stream stderr to real-time log callbacks
4. Capture stdout as resource content
5. Non-zero exit code → error result

### Bundle Mode

1. Create temp directory with three files:
   - `bundle.js` — self-contained JavaScript bundle (zod inlined)
   - `request.json` — method name, args, global args, definition metadata
   - `runner.js` — embedded runner script
2. Mount temp dir as `/swamp:ro` in container
3. Run `deno run --allow-all /swamp/runner.js`
4. Parse JSON output from stdout: `{ resources, files }`
5. Clean up temp directory

## Custom Drivers

Extensions can register custom execution drivers via `extensions/drivers/`.
These are TypeScript files that export a `driver` object with a `createDriver`
factory that returns an `ExecutionDriver`. Custom drivers enable execution in
environments swamp doesn't ship with — remote servers, cloud functions, custom
sandboxes, etc.

### Type Registry

The `DriverTypeRegistry` is a Map-backed singleton (`driverTypeRegistry`), using
the same pattern as the datastore registry. Built-in types (raw, docker) are
registered at startup. User-defined types are loaded from `extensions/drivers/`
via `UserDriverLoader`. Types must follow the `@collective/name` or
`collective/name` pattern. Duplicate type registrations are rejected with an
error.

### ExecutionDriver Interface

A custom driver implements a minimal interface:

- **`type`** (readonly) — the driver type identifier
- **`execute`** (required) — receives an `ExecutionRequest` (method name, args,
  definition metadata, optional bundle) and returns an `ExecutionResult` with
  status, outputs, logs, and duration. Outputs use `kind: "persisted"` when the
  driver writes data in-process, or `kind: "pending"` when the host must persist
  the data after execution.
- **`initialize?`** — optional setup hook
- **`shutdown?`** — optional cleanup hook

See `src/domain/drivers/execution_driver.ts` for the full interface.

### Loading & Bundling

`UserDriverLoader` follows the same pattern as `UserDatastoreLoader`: discovers
`.ts` files recursively (excluding `_test.ts`), bundles via Deno with zod
externalized, and validates the export against `UserDriverSchema` — requiring
`type`, `name`, `description`, an optional `configSchema`, and a `createDriver`
factory function. Files without a `driver` export are silently skipped. Bundles
are cached in `.swamp/driver-bundles/` with mtime-based invalidation.

### Resolution with Custom Drivers

Custom driver types follow the same resolution priority as built-in types
(CLI > step > job > workflow > definition > raw). The first non-undefined
`driver` value wins. Custom types are referenced by their full scoped name
(e.g., `driver: "@myorg/lambda"`).

### Custom Driver Implementation Files

| File | Purpose |
|------|---------|
| `src/domain/drivers/execution_driver.ts` | `ExecutionDriver` interface |
| `src/domain/drivers/driver_type_registry.ts` | Type registry singleton |
| `src/domain/drivers/user_driver_loader.ts` | Loader, validator, bundler |

## Self-contained Bundling

Extension models are bundled into JavaScript at load time. By default, zod is
externalized so in-process extensions share swamp's zod instance (required for
`instanceof` schema checks). For Docker execution, a **self-contained** bundle
is generated that inlines zod and all dependencies:

```typescript
bundleExtension(entryPath, { selfContained: true });
```

The self-contained bundle is stored as `bundleSource` on the model definition
and included as `request.bundle` in the `ExecutionRequest` envelope.

## Bundle Execution Flow

```
HOST                                    CONTAINER
────                                    ─────────

1. Build ExecutionRequest
   ├─ globalArgs, methodArgs
   ├─ definitionMeta
   └─ bundle (Uint8Array)

2. Create temp dir
   ├─ bundle.js          ──mount──▶  /swamp/bundle.js
   ├─ request.json       ──mount──▶  /swamp/request.json
   └─ runner.js          ──mount──▶  /swamp/runner.js

3. docker run ...                       4. runner.js
   --rm                                    ├─ Read request.json
   -v tempDir:/swamp:ro                    ├─ import bundle.js
   image                                   ├─ Create mock context
   deno run --allow-all                    │   ├─ writeResource → resources[]
   /swamp/runner.js                        │   └─ createFileWriter → files[]
                                           ├─ Execute method
                                           └─ Output JSON to stdout

5. Parse stdout JSON     ◀──stdout──    { resources, files }
6. Stream stderr         ◀──stderr──    [log lines]

7. Convert to DriverOutput[]
   (kind: "pending")

8. Host persists outputs
   via DataWriter
```

## Output Parity

Both drivers produce `DriverOutput[]` but with different `kind` values:

| Driver   | `kind`      | Data state                                      |
| -------- | ----------- | ----------------------------------------------- |
| `raw`    | `persisted` | Data already written; `handle` references it    |
| `docker` | `pending`   | Data needs host-side persistence via DataWriter |

The method execution service normalizes both: persisted outputs extract their
handle directly; pending outputs are written via `createResourceWriter` or
`createFileWriter` before returning the final result. The calling code sees
identical `DataHandle` arrays regardless of which driver ran.
