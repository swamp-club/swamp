# Execution Drivers for Models

Execution drivers control where and how model methods run. The default driver
(`raw`) runs methods in-process. The `docker` driver runs methods in isolated
containers.

## Built-in Drivers

| Driver   | Description                                             |
| -------- | ------------------------------------------------------- |
| `raw`    | In-process execution in the host Deno process (default) |
| `docker` | Isolated execution in Docker containers                 |

## CLI Override

Override the driver for a single method run:

```bash
swamp model method run my-model execute --driver docker
```

The CLI flag takes highest priority over all other driver settings.

## Definition YAML

Set the driver on a model definition so it always runs in a container:

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

### Docker Driver Config Fields

| Field         | Required | Description                                  |
| ------------- | -------- | -------------------------------------------- |
| `image`       | Yes      | Docker image to run                          |
| `bundleImage` | No       | Image for bundle mode (must have Deno)       |
| `command`     | No       | CLI binary: `docker`, `podman`, or `nerdctl` |
| `timeout`     | No       | Timeout in milliseconds                      |
| `network`     | No       | Docker network to attach                     |
| `memory`      | No       | Memory limit (e.g. `512m`)                   |
| `cpus`        | No       | CPU limit (e.g. `1.5`)                       |
| `volumes`     | No       | Volume mounts (e.g. `["/host:/container"]`)  |
| `env`         | No       | Environment variables                        |
| `extraArgs`   | No       | Additional docker run flags                  |

### Using Podman or nerdctl

Set `command` to use an alternative container runtime:

```yaml
driverConfig:
  command: "podman"
  image: "alpine:latest"
```

## Resolution Priority

When a model is run via a workflow, the driver is resolved from multiple sources
(first match wins):

1. CLI `--driver` flag
2. Workflow step `driver:` field
3. Workflow job `driver:` field
4. Workflow-level `driver:` field
5. Model definition `driver:` field
6. Default: `raw`

## Extension Model Compatibility

Extension models (TypeScript models in `extensions/models/`) work with the
Docker driver with no code changes. Swamp automatically generates a
self-contained bundle that inlines all dependencies (including zod) for
container execution. See the `swamp-extension` skill for details.

## Design Reference

For architecture details, execution flow diagrams, and implementation files, see
[design/execution-drivers.md](design/execution-drivers.md).
