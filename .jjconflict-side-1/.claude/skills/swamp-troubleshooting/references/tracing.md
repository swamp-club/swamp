# OpenTelemetry Tracing

Swamp has native OpenTelemetry tracing for diagnosing slow or failing
operations. Tracing is opt-in via environment variables and has zero overhead
when disabled.

## Quick Setup

```bash
# Local Jaeger (run once)
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest

# Enable tracing for any swamp command
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 swamp workflow run my-workflow

# View traces at http://localhost:16686 — search for service "swamp"
```

## When to Use Tracing

Tracing is most useful when:

- A workflow run is slow and you need to identify which step/method is the
  bottleneck
- Extension model methods are timing out and you need to see the full execution
  timeline
- Datastore sync (S3 pull/push) is slow and you want to measure lock acquisition
  and transfer times
- `data gc` is taking too long and you want to see how many entries are being
  processed
- Extension pull/push is failing and you want to see which network phase fails
- You need to trace context across Docker container boundaries to connect
  extension spans to the parent workflow

## Configuration

| Variable                      | Purpose                                | Default         |
| ----------------------------- | -------------------------------------- | --------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector URL (tracing off when unset) | _(unset = off)_ |
| `OTEL_TRACES_EXPORTER`        | `otlp`, `console`, or `none`           | `otlp`          |
| `OTEL_SERVICE_NAME`           | Service name in traces                 | `swamp`         |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Auth headers (`key=val,key=val`)       | _(none)_        |

### Console Exporter (No Collector Needed)

For quick debugging without running a collector:

```bash
OTEL_TRACES_EXPORTER=console swamp workflow run my-workflow
```

Spans are printed to stderr in a readable format showing traceId, parentId,
name, duration, and attributes.

### Cloud Providers

```bash
# Honeycomb
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_API_KEY"

# Grafana Cloud
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic YOUR_BASE64_TOKEN"
```

## What Gets Traced

### Workflow Execution Hierarchy

```
swamp.cli "workflow run"
  └─ swamp.workflow.run.command
       └─ swamp.workflow.run "deploy"
            ├─ swamp.workflow.evaluate
            ├─ swamp.workflow.job "build"
            │    ├─ swamp.workflow.step "compile" (20ms)
            │    │    └─ swamp.model.method → swamp.driver.execute
            │    └─ swamp.workflow.step "test" (parallel, 45ms)
            │         └─ swamp.model.method → swamp.driver.execute
            └─ swamp.workflow.job "deploy" (starts after build)
                 └─ swamp.workflow.step "apply"
                      └─ swamp.model.method → swamp.driver.execute
```

### All CLI Operations

Every libswamp generator is traced. Key span names:

- `swamp.model.method.run` — standalone model method execution
- `swamp.data.gc` — garbage collection (attributes: entries expired, bytes
  reclaimed)
- `swamp.extension.pull` / `.push` — registry network operations
- `swamp.datastore.sync` — S3 pull/push (attributes: direction, file count)
- `swamp.lock.acquire` — distributed lock acquisition
- `swamp.vault.put` / `.get` — secret storage/retrieval

## Diagnosing Common Issues

### Slow Workflow Runs

1. Enable tracing and run the workflow
2. In Jaeger, find the trace and look at the waterfall view
3. Identify which `swamp.workflow.step` spans are longest
4. Drill into `swamp.model.method` → `swamp.driver.execute` to see if the method
   itself is slow or if it's lock/sync overhead

### Slow Data GC

Look at the `swamp.data.gc` span attributes:

- `gc.entries_expired` — how many entries were processed
- `gc.versions_deleted` — how many versions were cleaned up
- `gc.bytes_reclaimed` — total bytes freed

### Extension Pull/Push Failures

The `swamp.extension.pull` and `swamp.extension.push` spans show the full
network operation. Push has three phases (initiate → upload → confirm) — the
span status and error message indicate which phase failed.

### Lock Contention

If `swamp.lock.acquire` spans are long, another process is holding the lock.
Check with `swamp datastore lock status` to see the current holder.

### Docker Driver Trace Propagation

When using `driver: docker`, swamp automatically sets `TRACEPARENT` as a
container environment variable. Extensions running in Docker that initialize
their own OTel SDK can read this env var to connect their spans to the parent
trace, creating a unified trace across process boundaries.

## Design Reference

See `design/tracing.md` for the full architecture, implementation files, and
span attribute reference.
