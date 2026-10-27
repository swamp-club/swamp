---
audience: operators, contributors
enables: [serve]
last-verified: 2026-10-27 @ HEAD
---

# Serve phase telemetry

Costly `swamp serve` paths export their cost as named phases, so a trace query
can say where the time went without profiling or debug logs. Phases are ordinary
OpenTelemetry spans on the existing pipeline. They observe only: no phase
changes what the work does, and a phase that cannot be exported is dropped
without failing the work.

Worker enrollment preparation is instrumented (lab #3986). Four more areas use
the same contract as they are added: run-detail output resolution (#4002),
worker deletion and prune (#4003), output retention (#4004) and access-data
polling (#4005).

Phases are observations of the
[remote telemetry contract](./remote-execution-telemetry.md)
(`src/domain/remote/observability.ts`), so they carry its `swamp.outcome`,
`swamp.telemetry.version` and `swamp.phase.*` coverage fields and feed its
`swamp.execution.*` metrics. The vocabulary and helpers live in
`src/domain/diagnostics/diagnostic_phase.ts`.

## Contract

Every phase is a span named `swamp.diagnostic.<phase>` with:

| Attribute                                                        | Type      | Meaning                                                                                             |
| ---------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `swamp.diagnostic.area`                                          | string    | The path: `enrollment`, `step_outputs`, `worker_delete`, `output_retention`, `access_poll`          |
| `swamp.diagnostic.phase`                                         | string    | The phase name, as in the span name                                                                 |
| `swamp.outcome`                                                  | string    | `ok`, `error`, `timeout`, `cancelled`, `closed`; span status is OK only for `ok`                    |
| `swamp.diagnostic.cancel_observed`                               | bool      | Set where the area has a cancellation signal: whether this process had seen it when the phase ended |
| `swamp.phase.local_ms`                                           | number    | Monotonic elapsed time of the phase                                                                 |
| `swamp.phase.child_covered_ms`                                   | number    | The part covered by child observations, unioned, never summed                                       |
| `swamp.phase.uncovered_ms`                                       | number    | The rest: work in the phase itself                                                                  |
| `swamp.phase.coverage_truncated`, `swamp.phase.pending_children` | bool, int | As in the remote contract                                                                           |
| `swamp.diagnostic.<counter>`                                     | int       | A count of items or attempts (per phase below)                                                      |
| `swamp.diagnostic.<work>_work_ms`                                | number    | Milliseconds of one kind of work summed across items: **not elapsed time**                          |

Areas and phases are closed vocabularies, never built from data. A phase is
exported only inside an area that lists it, or when it is one of the shared
phases any area may run (`definition_lookup`, `definition_scan`, `lock_wait`,
`lock_held`). Attributes a caller sets around shared code, such as
`swamp.diagnostic.lookup_attempt`, are inherited by every phase under it.

Values are counts, durations, booleans and fixed strings. One exception:
`swamp.diagnostic.definition_type` is the model type a lookup asked for (such as
`swamp/worker`), a name from the repository's registered types. It is never a
metric label. No phase carries a path, a definition or token name, a token, a
secret, resource content, a query or a payload. IDs stay on the parent spans
that already carry them.

Loops over files or records are one phase with counters and summed work, never a
span per item, so the span count of an operation does not grow with the number
of files it reads. `*_work_ms` excludes nested measurements of other kinds
within it, and holds only for sequential work. It includes failed attempts:
`read_work_ms` counts a read that found no file.

### Where phases come from

The path that owns the work sets the area, and async context carries it. Shared
code (the definition repository, the name index, file locks) exports phases only
while an area is active, so other callers look as before. An area wraps only the
awaited work being measured, never a call that arms timers or starts background
work, since that work would inherit it.

### Sampling and opt-out

With tracing off (no `OTEL_*` configuration) no phase is created and the
counters do no work. An unsampled phase does not count either; phases follow the
parent's sampling decision. `swamp.execution.*` metrics, when enabled, gain one
`operation` label per phase (`diagnostic.<phase>`). They are not split by area,
so per-area analysis uses traces.

## Enrollment

Parent: the `swamp.serve.transition` span with
`swamp.transition.operation =
enroll`, under `swamp.enrollment.request`. Waiting
behind other gateway transitions happens before that span starts: it is the
`swamp.transition.wait` span between the two, and the transition's
`swamp.transition.queue_wait_ms` and `swamp.transition.queue_depth`. The
transition span has a status but no `swamp.outcome`; the request span has both.
Inside the transition, the token definition lookup, the token record read and
the two method runs (redeem, then the worker's `enroll` or `set_status`) are in
the area. Each method run is a `swamp.model.method.run` span whose phases are
below.

| Phase               | Parent                             | Attributes                                                                                                                                                                                                    |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry_load`     | transition                         | Model, vault and report registries and run dependencies for one method run                                                                                                                                    |
| `token_record_scan` | transition                         | `records_listed`, `content_reads`, `bytes_read`, `unreadable`, `tokens`, `list_work_ms`, `read_work_ms`                                                                                                       |
| `prepare`           | `swamp.model.method.run`           | Everything before `swamp.model.method.setup`, including time the run's consumer holds an event it yielded. Ends `error` when the run reports an error before setup, `cancelled` when its consumer stops it    |
| `type_resolution`   | `prepare`                          | The model type lookup                                                                                                                                                                                         |
| `definition_lookup` | transition, `prepare`, `lock_held` | `definition_type`, `lookup_method`, `hit`, `source` (`primary`, `auto`, `none`), `lookup_attempt` (`initial`, `recheck`) inside a direct run; `files_read`, `bytes_read` for the name-derived files it probed |
| `definition_scan`   | `definition_lookup`                | `scan_root` (`primary`, `auto`), `scan_strategy`, `definition_type`, and the counters below                                                                                                                   |
| `lock_wait`         | `prepare`                          | `lock_kind=auto_definition`, `acquired`, `retries`; outcome `timeout` when the wait ran out                                                                                                                   |
| `lock_held`         | `prepare`                          | `lock_kind=auto_definition`: the re-check and the save or adoption under the creation lock                                                                                                                    |
| `definition_adopt`  | `prepare` or `lock_held`           | `definition_outcome=reused`                                                                                                                                                                                   |
| `definition_save`   | `lock_held`                        | `definition_outcome=created`                                                                                                                                                                                  |

`lookup_method` says which step answered: `name_file` (the file the name gives),
`primary_hint`, `primary_scan`, `secondary_hint`, `secondary_name_file`,
`secondary_index`, or `none` for a miss. New values may be added. Lookup is
scoped to one type: a worker lookup reads only worker definitions.

`bytes_read` counts the UTF-8 length of the text read, which can differ from the
file's size on disk when it holds invalid byte sequences.

`definition_scan` comes in two strategies:

- `full_listing` (`scan_root=primary`): every definition file of the type under
  `models/`. `files_examined`, `files_read`, `bytes_read`, `broken_files`
  (unparseable or a symlink leaving the repo, skipped), `definitions`,
  `read_work_ms`, `parse_work_ms`.
- `name_index` (`scan_root=auto`): the auto-definition name index (lab #3984).
  `index_checks_run` and `index_entries` when this lookup ran the index's check,
  `index_relists` when that check listed the directory again, and
  `index_checks_joined` when the lookup joined a check another lookup had
  queued. A joined check is not a child of the joining lookup; it ran under the
  lookup that queued it, and no span link joins them. `files_read`,
  `bytes_read`, `broken_files`, `read_work_ms` and `parse_work_ms` count the
  files the index read. The index's own `swamp.definition.name_index.validate`
  span (`name_index.entries`, `name_index.relisted`, `name_index.files_parsed`)
  nests under the scan of the lookup that ran it.

The lookup under the creation lock is the `definition_lookup` with
`lookup_attempt=recheck`. Its scans inherit the label, so a duplicate scan is
measurable. A file written within the name index's racy window (about two
seconds) is read again by each check, so a re-check soon after a burst of writes
can read the same files as the initial lookup. In-memory routing and validation
between lookup and setup are `prepare`'s `swamp.phase.uncovered_ms`.

Cancellation is observed, never acted on by these fields:

- `swamp.enrollment.request` carries `swamp.rpc.cancel_observed`: `false` from
  the start, `true` once this process sees the call cancelled, with
  `swamp.rpc.cancel_observed_ms` (monotonic, since the request started) and
  `swamp.rpc.cancel_cause` (`cancel_frame` when the worker's `rpc.cancel`
  arrived, `channel_closed` when the socket closed). A request span without the
  field came from a build without it, not from an uncancelled call.
  `swamp.rpc.request_id` ties it to the worker's call.
- Each enrollment phase records `cancel_observed` as it ends.
- The worker's own submit is its `swamp.rpc.submit` span with
  `swamp.rpc.frame=rpc.cancel`. A submit alone does not prove the server
  received it.

What enrollment does with a cancel is unchanged: a worker that gave up while
queued is skipped, and one that gave up during redeem stops before it is
recorded (outcome `closed`). Work already under way finishes.

## Queries

The examples use Axiom APL against a dataset that receives these traces (here
`swamp-serve-traces`). Conventions:

- Windows are explicit UTC ranges on `_time`, which is the span's **start**
  time. A span that crosses the window's end appears in the window it started
  in.
- Every query filters on `['service.name']`. The dataset also holds the worker's
  and UAT's spans, and a worker's `swamp.enrollment.request` has the same name
  as the server's. Change the filter when querying a test service.
- Failed, timed-out and cancelled phases are kept as separate rows by grouping
  on `swamp.outcome`, never dropped.
- A field a build does not export is missing, not zero or `false`. `tobool` and
  `coalesce` turn a missing value into one, so the queries test presence
  (`isnotnull`) and report older builds as `uninstrumented`.
- Field paths: span attributes are under `['attributes.custom']['<key>']` and
  the build is `['resource.custom']['swamp.version']`. Numbers and booleans keep
  their types.
- `percentile` is a percentile and `max` is a maximum; neither stands in for the
  other.
- Never add child durations or `*_work_ms` values to get wall time: use a span's
  own `duration` and `swamp.phase.uncovered_ms`.

Phase latency by phase, outcome and build:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| extend area=tostring(['attributes.custom']['swamp.diagnostic.area']),
         phase=tostring(['attributes.custom']['swamp.diagnostic.phase']),
         outcome=tostring(['attributes.custom']['swamp.outcome']),
         version=tostring(['resource.custom']['swamp.version']),
         ms=duration/1ms
| where area == 'enrollment'
| summarize n=count(), p50_ms=percentile(ms,50), p95_ms=percentile(ms,95), max_ms=max(ms)
  by phase, outcome, version
| sort by p95_ms desc
```

One operation's breakdown, by trace id:

```apl
['swamp-serve-traces']
| where trace_id == '<trace-id>'
| project _time, name, ms=duration/1ms, trace_id, span_id, parent_span_id,
          attrs=['attributes.custom'], status=['status.code']
| sort by _time asc
```

Worker lookups: hit versus miss, created versus reused, and scan cost against
the number of definitions read:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| extend a=['attributes.custom']
| where tostring(a['swamp.diagnostic.area']) == 'enrollment'
| where tostring(a['swamp.diagnostic.definition_type']) == 'swamp/worker'
     or name in ('swamp.diagnostic.definition_save', 'swamp.diagnostic.definition_adopt')
| extend phase=tostring(a['swamp.diagnostic.phase']),
         method=tostring(a['swamp.diagnostic.lookup_method']),
         attempt=tostring(a['swamp.diagnostic.lookup_attempt']),
         strategy=tostring(a['swamp.diagnostic.scan_strategy']),
         hit=tobool(a['swamp.diagnostic.hit']),
         definition=tostring(a['swamp.diagnostic.definition_outcome']),
         outcome=tostring(a['swamp.outcome']),
         files_read=toint(a['swamp.diagnostic.files_read']),
         entries=toint(a['swamp.diagnostic.index_entries']),
         ms=duration/1ms
| summarize n=count(), p50_ms=percentile(ms,50), p95_ms=percentile(ms,95), max_ms=max(ms),
            avg_files_read=avg(files_read), max_entries=max(entries)
  by phase, attempt, strategy, method, hit, definition, outcome
```

Which cost dominated each enrollment: waiting behind other transitions, a
new-name lookup, lock contention, the definition save, a warm lookup, the token
record scan or registry loading:

```apl
let from = datetime(2026-10-26T00:00:00Z);
let to = datetime(2026-10-27T00:00:00Z);
let service = 'swamp-serve-vm';
let phases = ['swamp-serve-traces']
  | where _time between (from .. to)
  | where ['service.name'] == service
  | extend a=['attributes.custom']
  | where tostring(a['swamp.diagnostic.area']) == 'enrollment'
  | extend phase=tostring(a['swamp.diagnostic.phase']),
           worker=tostring(a['swamp.diagnostic.definition_type']) == 'swamp/worker',
           attempt=tostring(a['swamp.diagnostic.lookup_attempt']),
           hit=tobool(a['swamp.diagnostic.hit']),
           ms=duration/1ms
  | summarize
      phase_spans=count(),
      new_lookup_ms=sumif(ms, phase == 'definition_lookup' and worker and hit == false),
      warm_lookup_ms=sumif(ms, phase == 'definition_lookup' and worker and attempt == 'initial' and hit == true),
      lock_wait_ms=sumif(ms, phase == 'lock_wait'),
      save_ms=sumif(ms, phase == 'definition_save'),
      token_scan_ms=sumif(ms, phase == 'token_record_scan'),
      registry_ms=sumif(ms, phase == 'registry_load')
    by trace_id;
let queued = ['swamp-serve-traces']
  | where _time between (from .. to)
  | where ['service.name'] == service
  | where name == 'swamp.serve.transition'
  | where tostring(['attributes.custom']['swamp.transition.operation']) == 'enroll'
  | project trace_id, queue_ms=todouble(['attributes.custom']['swamp.transition.queue_wait_ms']);
['swamp-serve-traces']
| where _time between (from .. to)
| where ['service.name'] == service
| where name == 'swamp.enrollment.request'
| project trace_id, request_ms=duration/1ms,
          outcome=tostring(['attributes.custom']['swamp.outcome'])
| join kind=leftouter (queued) on trace_id
| join kind=leftouter (phases) on trace_id
| extend queue_ms=coalesce(queue_ms, 0.0),
         new_lookup_ms=coalesce(new_lookup_ms, 0.0), warm_lookup_ms=coalesce(warm_lookup_ms, 0.0),
         lock_wait_ms=coalesce(lock_wait_ms, 0.0), save_ms=coalesce(save_ms, 0.0),
         token_scan_ms=coalesce(token_scan_ms, 0.0), registry_ms=coalesce(registry_ms, 0.0)
| extend top_ms=max_of(queue_ms, new_lookup_ms, warm_lookup_ms, lock_wait_ms, save_ms,
                       token_scan_ms, registry_ms)
| extend dominant=case(
    isnull(phase_spans), 'uninstrumented',
    top_ms == 0, 'unattributed',
    queue_ms == top_ms, 'gateway_wait',
    lock_wait_ms == top_ms, 'lock_contention',
    new_lookup_ms == top_ms, 'new_name_lookup',
    save_ms == top_ms, 'definition_save',
    token_scan_ms == top_ms, 'token_record_scan',
    registry_ms == top_ms, 'registry_load',
    'warm_lookup')
| summarize n=count(), p50_ms=percentile(request_ms,50), p95_ms=percentile(request_ms,95),
            max_ms=max(request_ms)
  by dominant, outcome
```

Each column sums one phase's spans in one enrollment. Within an enrollment those
spans are sequential (the initial lookup, then the re-check), so each sum is
that phase's share of the enrollment's wall time. The columns are compared,
never added: a re-check lookup runs inside `lock_held`. `dominant` names the
largest listed cost, not the whole of the request's time: the method runs' setup
and execution, and preparation outside these phases, are not categorised. A
request from a build without the phases is `uninstrumented`, never
`gateway_wait`. Each join key is one span per trace for the server service: one
request and one `enroll` transition per enrollment trace.

Cancellations as the server saw them, against how long the request ran:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| where name == 'swamp.enrollment.request'
| extend a=['attributes.custom']
| extend instrumented=isnotnull(a['swamp.rpc.cancel_observed']),
         cancelled=tobool(a['swamp.rpc.cancel_observed']),
         cause=tostring(a['swamp.rpc.cancel_cause']),
         cancel_ms=todouble(a['swamp.rpc.cancel_observed_ms']),
         outcome=tostring(a['swamp.outcome']),
         ms=duration/1ms
| summarize n=count(), p50_cancel_ms=percentile(cancel_ms,50), p95_ms=percentile(ms,95), max_ms=max(ms)
  by instrumented, cancelled, cause, outcome
```

Rows with `instrumented=false` came from builds without the field; their
`cancelled` is meaningless.

## What this does not establish

`integration/worker_enroll_phase_telemetry_test.ts` drives a real gateway
through the real OTLP exporter. It checks that names, parent ids, value types,
outcomes and statuses survive export for new, existing, contended, cancelled and
failed enrollments, and that an enrollment's phase count is the same with a
small and a large worker catalog.

Against production `swamp-serve-traces` (2026-10-27, build `b4dd513d`, before
these phases shipped), the field paths and types above were confirmed on real
enrollment spans. The phase-latency, single-trace, worker-lookup and
cancellation queries parsed and ran. The dominance query is too complex for
Axiom's legacy result format and needs the tabular format (the query editor or
`format=tabular`). Running these queries on exported phase spans in a test
dataset, and measuring overhead on a deployed server, is evidence collected
after deployment.
