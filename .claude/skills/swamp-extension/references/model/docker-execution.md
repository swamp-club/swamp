# Docker Execution for Extension Models

Extension models run in Docker containers with no code changes. Swamp
automatically generates a self-contained bundle that inlines all dependencies
(including zod) for out-of-process execution.

## How It Works

1. At model load time, swamp bundles the TypeScript extension with
   `selfContained: true`, inlining zod and all npm dependencies
2. When the Docker driver executes, it mounts the bundle, a request payload, and
   a runner script into `/swamp/` inside the container
3. The runner calls `writeResource()` and `createFileWriter()` which capture
   outputs as JSON
4. The host persists the captured outputs identically to in-process execution

## Container Requirements

The container image must have **Deno** installed for bundle mode. Use
`denoland/deno:alpine` or any image with Deno available:

```yaml
driverConfig:
  bundleImage: "denoland/deno:alpine"
```

If `bundleImage` is not set, the `image` field is used for both command and
bundle modes.

## Definition YAML Example

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-extension-model
version: 1
driver: docker
driverConfig:
  image: "alpine:latest" # For command mode
  bundleImage: "denoland/deno:alpine" # For bundle mode (has Deno)
  timeout: 60000
  memory: "512m"
methods:
  run:
    arguments: {}
```

## API Compatibility

All context methods work identically in Docker:

| Method                       | Docker Behavior                               |
| ---------------------------- | --------------------------------------------- |
| `context.writeResource()`    | Captured as JSON, persisted by host           |
| `context.createFileWriter()` | Content base64-encoded, persisted by host     |
| `context.logger`             | Logs go to stderr, captured as real-time logs |
| `context.globalArgs`         | Passed via request.json                       |
| `context.definition`         | Passed via request.json                       |

**Not supported in Docker:** `getFilePath()` throws — use `writeAll()`,
`writeText()`, or `writeStream()` instead.

## Design Reference

For the full architecture, bundle execution flow, and output parity details, see
[design/execution-drivers.md](design/execution-drivers.md).
