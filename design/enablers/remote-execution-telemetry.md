# Remote execution telemetry (contract v1)

The domain observation port is `src/domain/remote/observability.ts`. Its OTel
adapter lives in infrastructure. Observations do not authorize work or change
retry, lease, or recovery policy. Payloads, predicates, credentials, and exception
messages are excluded from the new observation attributes.

## Native waterfall

Step dependency waits begin when the expanded job graph is admitted, before
walking its dependency levels. Scheduler waits begin when a level is reached and
end when its step generator starts. Waits for generators that never start end
with `closed` when the job walk exits, including suspension and abandonment.
Completed steps on resume do not acquire new waits. These observations do not
cover earlier job dependency waits or graph expansion.

The logical dispatch spans queueing and attempts. Each actual dispatch attempt
has a fresh identity, even after a no-write disconnect. Its send span captures
context at send time. Worker dispatch, runner startup, preparation and execution
continue that context. Capability RPC client spans propagate through both stdio
and the supervisor bridge; the bridge preserves the incoming request ID on its
server span while the outbound client span records the remapped ID.

The worker HTTP client sends its active client-span context. Serve resolves the
authenticated dispatch before accepting that parent. Missing, malformed,
cross-trace, or differently sampled context falls back to the dispatch's trusted
parent. Worker headers cannot select a workflow or lease. The returned execution
context parents serve's lease-settlement span. Old peers may omit these optional
fields; execution still works, with less detailed parentage.

Supported carriers are W3C version `00`, nonzero trace and span IDs, sampling
flags `00`/`01`, and at most 512 printable bytes of tracestate. Correlation IDs
are span attributes, never metric labels. A shared warm worker's connection
lifecycle is linked from its dispatch span, not made the parent of unrelated
jobs. A provisioning caller can explicitly supply the existing `TRACEPARENT`
and `TRACESTATE` environment contract for a causally provisioned cold worker.
Core observes process/connect activity; it does not invent cloud boot events.

## What time and outcomes mean

All `swamp.phase.*_ms` accounting uses local monotonic clocks. Direct local child
intervals are unioned and clipped, so overlapping or nested work is not added
twice. `uncovered_ms` remains explicit. Retention is capped at 1024 child
intervals per active observation; `coverage_truncated` marks incomplete
accounting. Remote child durations are not subtracted from a local parent because
cross-host clock error is unknown.
`pending_children` records direct observed children still running when the
parent ends; their unfinished intervals remain uncovered at that cutoff, even
if they subsequently complete. Affinity waits and post-refusal pool waits have
their own observations.
These fields do not establish end-to-end
99% coverage by themselves.

`rpc.submit` means handed to the transport, not delivered to the peer. A query
has separate service and JSON-safe clone observations. RPC timeout/cancellation
and later peer completion are separate outcomes. Late correlation retains at
most 1024 entries per channel for five minutes, with lazy expiry and clearing
on close; later or unretained responses are explicitly `unknown`.

HTTP client spans include body consumption and end on EOF, body failure or
cancellation. Partial responses record bytes consumed. A discarded line-write
response body is cancelled; that observation is distinct from the method's
successful return. Resource persistence records the immutable returned data
identity/version with `commit.guarantee=writer_returned`. This is the writer's
existing guarantee, not a new durability or peer-ACK promise. A failed transport
can leave commit state unknown; reconciliation is unsupported and no retry is
introduced.

Webhook receipts get unique IDs. Pending records persist receipt context
separately from caller context, with a backward-compatible SQLite migration.
Replay preserves the original queue timestamp when available. Queue spans end
on dequeue or shutdown; detached run observations link to the receipt and record
the root workflow run ID. Old pending records fall back to their pending ID.

## Metrics activation and interpretation

Enable application metrics explicitly with `OTEL_METRICS_EXPORTER=otlp` and an
OTLP HTTP endpoint. Existing trace/log configuration alone does not opt in.
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is a complete URL; otherwise
`/v1/metrics` is appended to `OTEL_EXPORTER_OTLP_ENDPOINT`. Metrics-specific
headers override generic headers. Resources use the existing service/fleet
identity. Export is every 10 seconds, with a five-second fetch deadline, and is
drained after trace shutdown.

The `swamp.execution` meter exports started, finished, sampled and parent-coverage
counters; duration histograms in seconds; and in-flight count and oldest-age
gauges. Dimensions are closed operation/outcome/coverage vocabularies. IDs,
worker names, predicates and payloads are not dimensions. Duration boundaries
range from 0.0001 through 1800 seconds, followed by the overflow bucket.
Cumulative counters reset with the process.
Resources default `service.instance.id` to a process-unique UUID shared across
signals, so separate worker counters do not collide. An explicit resource
attribute overrides this default and must remain unique per process.
In-flight gauges include operations
that have never emitted a completed span. Traces need not be enabled for metrics.

`swamp.export.spans` distinguishes attempted, collector-acknowledged, and
not-fully-acknowledged batches. HTTP failure and OTLP partial rejection are not
reported as success. Collector acknowledgment does not establish downstream
storage. Loss of the metrics exporter itself can hide this accounting.

## Acceptance evidence

Use a compiled binary and an isolated local repo, collecting raw OTLP for serve,
workers and runners. Run 36 concurrent readiness/query/small-write probes, then
repeat on the same warm workers. Keep baseline and instrumented runs matched
for concurrency, initial history, collector, build and sampling configuration.
Retain binary hashes, raw spans/metrics, run windows and per-probe outcomes.

In a standard trace viewer, verify exact trace IDs and parent IDs for dispatch →
worker → RPC/query and worker write → persistence → completion. Export one
explicitly provisioned cold case and one reused-worker case. Links are suitable
for detached lifecycles, not substitutes for causal parents.

For each fixed window, publish attempted/completed/pending counts, oldest pending
age, missing/unsampled/export-rejected counts, and outcome-separated
n/p50/p95/p99/max. Treat uncovered and clock-uncertain intervals as unknown.
Report matched-load overhead with sample counts; a successful probe is not a
99% coverage result. Durable subprocess acceptance belongs in `swamp-uat`.
