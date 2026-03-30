# Execution Drivers for Workflows

Execution drivers can be configured at the workflow, job, or step level to
control where model methods run.

## Per-Level Driver Override

```yaml
id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
name: mixed-driver-workflow
version: 1
driver: raw # Default for all steps in this workflow
driverConfig: {}
jobs:
  - name: build
    driver: docker # Override for all steps in this job
    driverConfig:
      image: "node:20-alpine"
      memory: "1g"
    steps:
      - name: compile
        task:
          type: model_method
          modelIdOrName: builder
          methodName: build
      - name: lint
        driver: raw # Override: run this step in-process
        task:
          type: model_method
          modelIdOrName: linter
          methodName: check
  - name: deploy
    dependsOn:
      - job: build
        condition:
          type: succeeded
    steps:
      - name: push
        driver: docker
        driverConfig:
          image: "alpine:latest"
          env:
            DEPLOY_ENV: production
        task:
          type: model_method
          modelIdOrName: deployer
          methodName: deploy
```

## Resolution Priority

The first non-undefined `driver` value wins (no merging across levels):

1. CLI `--driver` flag (highest)
2. Step `driver:` field
3. Job `driver:` field
4. Workflow `driver:` field
5. Model definition `driver:` field
6. Default: `raw`

## CLI Override

Override the driver for all steps in a workflow run:

```bash
swamp workflow run my-workflow --driver docker
```

## Parallel Steps

Steps within the same job run in parallel. When using the Docker driver, each
step runs in its own container. Container isolation means parallel steps cannot
interfere with each other's file system or processes.

## Design Reference

For architecture details, Docker driver configuration schema, and implementation
files, see [design/execution-drivers.md](design/execution-drivers.md).
