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

Worker enrollment preparation (lab #3986), run-detail output resolution
(#4002), worker deletion and prune (#4003), output retention (#4004) and
access-data polling (#4005) are instrumented.

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
| `swamp.diagnostic.result`                                        | string    | When set, what the phase achieved: `completed`, `partial`, `applied`, `no_change`, `skipped`        |
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
`lock_held`, `gate_wait`). A span that already existed can count as a phase
instead of being duplicated: it carries the area and phase attributes but keeps
its own name, and is not an observation, so it has no `swamp.outcome` and no
coverage fields (the sync gate's wait span is `gate_wait`). A poller's gated
pull has no such span, so the access poller's `gate_wait` is an observation
named `swamp.diagnostic.gate_wait`, with an outcome. Attributes a caller sets
around shared code, such as `swamp.diagnostic.lookup_attempt`, are inherited by
every phase under it.

Values are counts, durations, booleans and fixed strings. One exception:
`swamp.diagnostic.definition_type` is the model type a lookup asked for (such as
`swamp/worker`), a name from the repository's registered types. It is never a
metric label. No phase carries a path, a definition or token name, a token, a
secret, resource content, a query or a payload. IDs stay on the parent spans
that already carry them.

Loops over files or records are one phase with counters and summed work, never a
span per item, so the span count of an operation does not grow with the number
of files it reads. `*_work_ms` excludes nested measurements of other kinds
within it on the same async path. Measurements running concurrently (reads in
parallel batches) each add their own time, so their sum can exceed the phase's
duration. It includes failed attempts: `read_work_ms` counts a read that found
no file.

### Where phases come from

The path that owns the work sets the area, and async context carries it. Shared
code (the definition repository, the name index, file locks, the output
repository, the sync gate) exports phases only
while an area is active, so other callers look as before. An area wraps only the
awaited work being measured, never a call that arms timers or starts background
work, since that work would inherit it. Work an area schedules but does not own,
such as the policy snapshot rebuild a change event sets off, is armed outside
any area.

An operation written as an async generator binds the area to each step of the
generator, so the consumer's code between steps is outside it. A phase that
spans such steps ends `cancelled` when the consumer stops the generator early.
`swamp.outcome` says whether a phase raised. Where the work reports a failure
as an event rather than raising one, the phase ends `error` all the same, and
`swamp.diagnostic.result` says what a phase that did not fail achieved.

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

In `swamp serve`, a direct-type workflow step's lookup of its definition by name
across every type is a `definition_lookup` with `lookup_method=global_index`
(lab #4037). It sets `hit` and `source`, and runs under `prepare` for the first
lookup and `lock_held` for the re-check under the creation lock. A hint from an
earlier lookup of a definition under `models/` still answers before it, as the
`name_hint_hits` counter. Every other lookup by name across every type, in serve
or the CLI, walks every definition and opens no phase.

`bytes_read` counts the UTF-8 length of the text read, which can differ from the
file's size on disk when it holds invalid byte sequences.

`definition_scan` comes in three strategies:

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
- `global_index` (`scan_root=all`): the check of serve's definition index (lab
  #3968) that a `global_index` lookup runs before it reads the files declaring
  the name. It carries the same attributes as `owner_index` below (`cache`,
  `definitions`, `dirs_checked`, `dirs_relisted`, `dirs_joined`,
  `files_parsed`, `files_joined`), and the
  `swamp.serve.definition_index.validate` span nests under it.

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

## Run-detail output resolution

Parent: `swamp.workflow.step_outputs.resolve`, under
`swamp.workflow.history.get`, when a `workflow.history.get` request (or
`swamp workflow history outputs`) renders step outputs (lab #4002). The area
carries the request's cancellation, so every phase records `cancel_observed`.

| Phase          | Parent                                | Attributes                                                                                                                                  |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog_open` | `swamp.workflow.step_outputs.resolve` | Opening the data catalog and the data repository                                                                                            |
| `output_walk`  | `swamp.workflow.step_outputs.resolve` | The walk over every step's resources and child runs; counters below                                                                         |
| `owner_index`  | `output_walk`                         | The definition index check (lab #3968) on the request's first owner lookup; the `swamp.serve.definition_index.validate` span nests under it |

`output_walk` handles one resource at a time, so its `*_work_ms` values are
disjoint shares of its duration. Per resource it authorizes, then reads, then
parses:

| Attribute                                                                   | Meaning                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `result`                                                                    | `completed`, or `partial` when the walk failed or was cancelled; the counters then hold what it reached                                          |
| `authorize_allowed`, `authorize_denied`, `authorize_errors`                 | Read decisions on each resource. A cancel during a decision is the walk's outcome, not an error                                                  |
| `authorize_work_ms`                                                         | The decisions, without the owner lookups inside them                                                                                             |
| `owner_lookups`, `owner_lookups_reused`                                     | Owner lookups (model by id, or workflow), and those the request's memo answered without a new lookup or scan. Distinct owners are the difference |
| `owner_lookup_work_ms`                                                      | Finding owners. Includes the `owner_index` phase when it ran in this request, and time spent waiting on another request's listing                |
| `files_read`, `bytes_read`, `read_work_ms`, `parse_work_ms`, `broken_files` | Definition files the per-id owner lookups read, as the definition repository counts them. Excluded from `owner_lookup_work_ms`                   |
| `resources_attempted`                                                       | Reads attempted after an allow; equals `step_outputs.resources_read`. Not unique resources and not successful reads                              |
| `reads_succeeded`, `reads_missing`, `reads_failed`                          | Content reads that returned content, found none, or threw                                                                                        |
| `content_bytes`, `content_read_work_ms`                                     | Bytes of content read, and the time reading it                                                                                                   |
| `json_parse_work_ms`, `parse_failed`, `parse_not_object`                    | Decoding and parsing content; content that did not parse, or parsed to something other than an object                                            |
| `child_run_lookups`, `child_runs_unique`, `child_runs_missing`              | Child-run lookups for workflow steps, the distinct runs among them, and lookups that found no run. Lookups are not cached                        |
| `child_run_lookup_work_ms`                                                  | Reading child run records. Their resources are counted with the rest                                                                             |
| `assemble_work_ms`                                                          | Merging each step's attributes into outputs and grouping sources                                                                                 |

Counters are exported as `0` when nothing was counted. Without a read policy
(the CLI, or serve with authorization off) the `authorize_*` and `owner_*`
fields are absent.

`owner_index` carries `cache` (`cold` for the first check of an empty index,
`warm` when nothing was listed or read again, `refreshed` otherwise),
`definitions`, `dirs_checked`, `dirs_relisted`, `files_parsed`, and
`dirs_joined` and `files_joined`: the part of the relisting that came from a
listing another request had started. A joined listing runs under the request
that started it, and its files are counted there; the joiner counts them only as
joined, so `files_parsed - files_joined` summed over requests is the number of
files parsed. The joiner's validate span links to the validate span of the
request that started the listing. The validate span also gains
`definition_index.dirs_joined` and `definition_index.files_joined`, with its
other attributes unchanged. Definition files the index check reads are counted
in `owner_index`'s tally (`files_read`, `bytes_read`, `broken_files`,
`read_work_ms`, `parse_work_ms`); the work is cumulative across up to 32
parallel reads.

Supported branches: serve with its definition index (every `swamp serve`), the
full scan a `CanonicalResources` without an index falls back to (no
`owner_index`; the definition repository's shared `definition_scan` and
`definition_lookup` phases appear under `output_walk` where that branch runs
them), and the CLI (no read policy). The datastore engine does not change the
phases.

## Worker deletion

Worker **record** deletion: the worker's definition, outputs and data in the
repository. It is not machine or VM teardown. The serve worker GC sweep, the
`worker.prune` admin request and `swamp worker prune` from the CLI all run the
same prune, so all export these phases when tracing is on; the CLI's spans carry
the CLI's service name.

Parent: `swamp.worker.prune`. Each eligible worker is deleted through
`modelDelete`, whose `swamp.model.delete` span (with `model.name`, `model.type`
and `model.id`) nests under `delete_loop`. A plain `swamp model delete` runs
outside the area and exports none of these phases. The GC sweep's wait for the
exclusive sync gate happens before the prune, as the existing
`swamp.serve.sync_gate.wait` span (`sync_gate.mode=exclusive`) in a trace of its
own; it is not a phase of this area.

| Phase                      | Parent               | Attributes                                                                                                                                                                                       |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prune_pass`               | `swamp.worker.prune` | `workers_deleted`, `workers_failed`, `bindings_pruned`, `tokens_cleaned`; `result` `completed`, `partial` (a delete or binding prune failed), `no_change` (nothing eligible), `skipped` (dry run) |
| `worker_listing`           | `prune_pass`         | `workers`; outcome `error` when the list cannot be read, and the pass with it                                                                                                                    |
| `eligibility`              | `prune_pass`         | `considered`, `eligible`, and one of `skipped_not_disconnected`, `skipped_no_disconnect_time`, `skipped_within_grace` per kept worker                                                             |
| `delete_loop`              | `prune_pass`         | `sequential=true`, `batch_size`, `attempted`, `deleted`, `failed`; `result` `completed` or `partial`                                                                                             |
| `model_delete`             | `swamp.model.delete` | One per worker. `definition_type`; a refused delete ends `error` with `refusal` (`not_found`, `workflow_referenced`, `live_data`)                                                                |
| `definition_resolve`       | `model_delete`       | `hit`; `name_hint_hits`, `primary_walks`, `secondary_walks`; `files_read`, `bytes_read`, `read_work_ms`, `parse_work_ms` for the definitions a walk read                                         |
| `workflow_reference_check` | `model_delete`       | `workflows` (every workflow, loaded), `referencing`, `reference_match_work_ms`                                                                                                                   |
| `data_discovery`           | `model_delete`       | `artifacts`                                                                                                                                                                                      |
| `expiry_check`             | `model_delete`       | `checker` (whether expiry is checked at all), `checked`, `expired`, `live`, `check_failed`                                                                                                       |
| `output_discovery`         | `model_delete`       | `outputs` (this worker's); `files_read`, `bytes_read`, `read_work_ms`, `parse_work_ms` for every output record of the type                                                                       |
| `output_removal`           | `model_delete`       | `attempted`, `deleted`; `search_files_read`, `search_work_ms`, `remove_work_ms`, `dir_cleanup_work_ms`, `tombstone_work_ms`                                                                      |
| `data_removal`             | `model_delete`       | `expired_deleted`, `live_deleted`, `versions_removed`; `version_list_work_ms`, `file_remove_work_ms`, `catalog_update_work_ms`, `latest_update_work_ms`, `change_stage_work_ms`                  |
| `evaluated_removal`        | `model_delete`       | `lookup_work_ms`, `file_remove_work_ms`, `change_stage_work_ms`                                                                                                                                  |
| `definition_removal`       | `model_delete`       | `lookup_work_ms`, `file_remove_work_ms`, `event_publish_work_ms`, `change_stage_work_ms`                                                                                                         |
| `binding_cleanup`          | `prune_pass`         | `affected_tokens`, `tokens_checked`, `attempted`, `bindings_pruned`, `tokens_cleaned`, `failed`; `token_list_work_ms`, `worker_relist_work_ms`, `stale_resolve_work_ms`, `binding_prune_work_ms` |

`binding_cleanup` runs after `delete_loop`, as its sibling, so its time is never
part of the deletions'. Its `result` is `no_change` when no worker was deleted
or no binding was stale, `skipped` when there is no binding resolver (the CLI)
or the worker list could not be read again, and `partial` when a binding prune
failed. Its binding prune is a `swamp.model.method.run` of the token's
`prune_bindings`, nested under it.

Counters: `attempted` counts tries, `deleted` and `bindings_pruned` successes,
`failed` failures. On a `delete_loop` that was not cancelled,
`attempted = deleted + failed`. Counts of a list (`workers`, `considered`,
`artifacts`, `outputs`, `workflows`, `referencing`, `versions_removed`) are set,
zero included, whenever their phase ran to its end, as are `binding_cleanup`'s
`bindings_pruned`, `tokens_cleaned` and `failed` when it did not raise. The
`prune_pass` totals are set only on a pass that reached its result: they are
missing when the worker list could not be read, the consumer stopped the prune
early, or `binding_cleanup` raised. Counters bumped per item or event
(`eligible`, `skipped_*`, `attempted`, `deleted`, `checked`, `*_walks`) are
missing, not zero, when nothing happened.

Repeated discovery shows in the per-worker counters. Resolving a worker's
definition by name walks every definition in the repository until a hint from an
earlier lookup spares it (`primary_walks`, `files_read` against
`name_hint_hits`). The reference check loads every workflow. Output discovery
reads every output record of the worker type to find one worker's (`files_read`
against `outputs`). Removing one output reads its method's records until it
finds the file (`search_files_read`). All of these repeat for each worker in a
pass.

Index, catalog and staging upkeep is not a separate span: it happens per record,
between the file removals, so it is reported as `*_work_ms` on the removal phase
it belongs to. `catalog_update` is the data catalog rows, `latest_update` the
data latest markers, `change_stage` the datastore change signals and typed
staging (including the definition repository's reads of the files it stages),
`tombstone` an output's typed tombstone, `event_publish` the definition-deleted
event, and `file_remove` the file and empty-directory removal itself. Outputs
are removed by the code output retention uses, so `output_removal` reports that
removal under retention's keys: `remove` (the staged removal, signal included)
and `dir_cleanup`. Each key excludes the others nested in it, so the removal
keys plus the upkeep keys are at most the phase's duration; the rest of the
phase is in neither.

Bytes deleted are not exported: knowing them would cost a stat per file the
delete does not otherwise need. `bytes_read` counts what discovery read.

The deletes run one worker at a time, and each delete's stages run in order, so
within one prune the phases of a kind do not overlap and their durations can be
summed per trace. Phases of different kinds nest (`model_delete` holds the
stages under it), so sum only one level.

Cancellation is observed only. The admin request's cancel is recorded as each
phase's `cancel_observed`; the prune carries on and finishes. A consumer that
stops the prune early ends the open phases `cancelled`, and a worker whose
delete had finished keeps its `ok` phases.

The area covers everything the prune awaits, not only the stages above. The
worker list is a data query and a binding prune runs the token's method, so a
shared phase (`definition_lookup`, `definition_scan`, `lock_wait`, `lock_held`,
`gate_wait`) or a repository tally they reach is exported under
`worker_listing` or `binding_cleanup`, with keys this table does not list.

Datastores: the phases cover the filesystem repositories every datastore uses
for these records. A datastore extension's own `markDirty` runs inside
`change_stage`. Work it schedules for later (a timer, a detached promise)
still carries the area through async context: a phase it starts is exported
under whatever phase is open when it runs, and a measurement it makes after its
phase ended is lost. No first-party datastore schedules such work; this
affects only telemetry, never the deletion.

## Output retention

Parent: the `swamp.retention.batch` span with `retention.kind = outputs`. It
keeps `retention.deleted` (the outputs that batch removed, as before) and now
also carries `retention.bytes_reclaimed` and `retention.more` (the batch
stopped at its limit and another follows). Batches of the other kinds carry
the same three attributes and export no phases.

`runRetentionPass` sets the area for each outputs batch, so serve's hourly
pass and the CLI's end-of-command pass both export these phases. Serve takes
the sync gate and a root unit of work for each batch; the CLI does neither, so
it has no `gate_wait` and its `batch_commit` is near zero.

```
swamp.retention.batch                     retention.kind=outputs
└─ swamp.diagnostic.retention_batch
   ├─ swamp.serve.sync_gate.wait          phase=gate_wait (serve only)
   ├─ swamp.diagnostic.candidate_enumeration
   ├─ swamp.diagnostic.candidate_scan
   ├─ swamp.diagnostic.orphan_log_sweep   (only on a batch that did not stop at its limit)
   └─ swamp.diagnostic.batch_commit
```

The children run one after another, never overlapping, so within one batch
their durations add up to at most the batch's. `retention_batch`'s
`swamp.phase.uncovered_ms` is the rest: the gate wait (the tagged gate span is
not an observation, so it is not counted as covered) and the collector's own
setup. For outputs batches the gate span's parent is now `retention_batch`, not
`swamp.retention.batch`: a query that joins the two by `parent_span_id` must
go one level further up.

| Phase                   | Attributes                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retention_batch`       | `batch_size` (the pass's; an outputs batch removes up to ten times as many, see `limit`); on success `deleted`, `bytes_reclaimed`, `more`                     |
| `gate_wait`             | The `swamp.serve.sync_gate.wait` span, tagged: `sync_gate.mode`, `sync_gate.acquired`. Waiting, not working                                                     |
| `candidate_enumeration` | `scan_strategy` (`full_listing`: every batch lists every output record), `files`                                                                                 |
| `candidate_scan`        | `limit`, `dry_run`, `stopped_at_limit`; counts and work below                                                                                                    |
| `orphan_log_sweep`      | `dry_run`; `logs_listed`, `logs_skipped_recent`, `candidates`, `dirs_checked`, `dirs_unreadable`, `removed`, `bytes_reclaimed`; `list_work_ms`, `stat_work_ms`, `reference_read_work_ms`, `remove_work_ms` |
| `batch_commit`          | `disposition` (`commit`, or `abandon` after the collector threw)                                                                                                 |

`candidate_scan` is one span for the whole loop. Its counts, each the number
of output records:

| Count                    | Meaning                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `considered`             | Records the loop reached. A batch stopped at its limit does not reach the rest                       |
| `skipped_recent_mtime`   | Modified after its cutoff, so not read                                                               |
| `protected_not_terminal` | Read, and its run has not finished: retention never removes it, whatever its age                     |
| `skipped_not_expired`    | Read, and its start time is missing, invalid or after its cutoff                                    |
| `skipped_not_found`      | Gone between the listing and the read                                                                |
| `eligible`               | Expired and inside the limit. The record that stopped a batch at its limit is not counted            |
| `delete_attempted`       | Removals started; equal to `eligible`                                                                |
| `deleted`                | Removals that finished (on a dry run, records that would have been removed)                          |
| `failed`                 | A record whose check or removal threw anything but not-found. The batch stops there with `swamp.outcome=error` |
| `bytes_reclaimed`        | Bytes of the removed records and the run logs they own, measured before removal                      |

`considered`, `eligible`, `delete_attempted`, `deleted` and `failed` are always
exported, zero included; the others only once they count something.
A batch that fails partway keeps the counts it reached, so `deleted` on a
failed `candidate_scan` is what was removed before the error. Two edge cases
break `delete_attempted = deleted + failed`: a record that vanishes during its
own removal counts `skipped_not_found` after `delete_attempted`, and a record
whose files were removed but whose change signal or tombstone then failed
counts `failed`, not `deleted`. On a dry run the sweep's `removed` and
`bytes_reclaimed` count the logs it would have removed.

Summed work on `candidate_scan`, in milliseconds. The first three are
eligibility and the last three are deletion:

| Work                  | Covers                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `stat_work_ms`        | Stat of each record (the modification-time check)                                                |
| `read_work_ms`        | Reading records that passed it                                                                   |
| `parse_work_ms`       | Parsing them                                                                                     |
| `remove_work_ms`      | Stat of the owned run log, then removing the record and its log, with the change signal that marks them for the datastore sync |
| `dir_cleanup_work_ms` | Removing directories the removal left empty                                                      |
| `tombstone_work_ms`   | Staging the record's typed `output.delete` change (the v3 index entry; on v2 it returns at once)            |

A work field is missing when that work never ran: an empty batch has no
`stat_work_ms`, and a dry run has no `tombstone_work_ms`. The cutoff of each
record (its method's `outputLifetime` or the kind's retention) is computed in
memory and not measured.

`batch_commit` starts when the collector settles and ends when the batch's
wrapper returns. On serve that is the end of the root unit of work (on v2 the
flush that pushes changed files to the datastore; on v3 the commit-log commit)
and the gate release. Its outcome is `error` only when the end of the unit
throws. Serve logs a failed push to a remote datastore instead of throwing it,
so such a push still ends `ok`: the log line, not the phase, records it. After
a collector error the unit is abandoned, and the push still runs. `batch_commit` times the end of the unit but is not its context, since
`runBatch` owns that work: a `lock_wait` or `lock_held` from a file lock the
push or commit takes appears under `retention_batch`, beside `batch_commit`
rather than inside it, and `batch_commit`'s `swamp.phase.child_covered_ms` is
always zero. A shared phase run inside any other stage appears under that
stage.

Retention stops only between batches (shutdown, budget, back-off), so no batch
is cut short: this area has no `cancelled` outcome and no `cancel_observed`. A
pass stopped before a batch exports no phases for it. Output records are read
through `YamlOutputRepository` on every datastore; there is no other branch.

## Access-data polling

Parent: the `swamp.serve.poll` span with `swamp.serve.poller = access_data`,
the root of each cycle's own trace. Inside it, `poll_cycle` holds the cycle's
phases. Every phase of the cycle carries `swamp.diagnostic.source_mode`:

- `local_change_source`: a v2 filesystem datastore with no sync service. Peers
  share the files, so the poller fingerprints the grant and group directories.
  There is no gate and no pull.
- `sync_pull`: a datastore with a sync service (S3, GCS, a custom datastore
  that syncs). The poller pulls the grant and group subdirectories under the
  sync gate.

A v3 datastore, or a custom one without a sync service, has no poller and
exports nothing.

| Phase                 | Parent       | Attributes                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `poll_cycle`          | poll span    | `changed` (absent when the pull never ran); `reload_reason` (`changed`, `pending_retry`, `unreadable_retry`, `none`); `unreadable_records` when it checked for a retry; `result` (`applied`, `no_change`, `skipped`); `consecutive_failures` when it failed. Outcome `cancelled` when `stop()` ended its gate wait and nothing was reloaded                                                                                                          |
| `change_detection`    | `poll_cycle` | Local only. `records` (record directories fingerprinted; a watched directory that could not be listed is an unreadable entry, not a record), `entries` (entries examined in them), `unreadable_entries`, `changed` (peer changes), `own_changes_excluded` (changes that were this process's own writes), `baseline_missing` (bool: no baseline, so the cycle reloads without comparing; `changed` is then absent)                                    |
| `gate_wait`           | `poll_cycle` | Sync pull with a gate only. An observation, `swamp.diagnostic.gate_wait`, not the tagged gate span. `gate_mode` (`opportunistic`, `queued`), `consecutive_skips` (before this wait), `attempts` (opportunistic tries), `acquired` (bool). Outcome `ok` when acquired or skipped because the gate stayed busy, `timeout` when a queued wait ran out its bound, `cancelled` when `stop()` ended it                                                     |
| `remote_pull`         | `poll_cycle` | Sync pull only, when the gate was acquired or there is none. `count_reported` (bool: whether the datastore returned a count), `changed` when it did. Outcome `timeout` when the pull ran past its deadline                                                                                                                                                                                                                                           |
| `catalog_invalidate`  | `poll_cycle` | When `changed` > 0: drops the catalog's cached state                                                                                                                                                                                                                                                                                                                                                                                                 |
| `snapshot_queue_wait` | `poll_cycle` | On every reload. `builds_ahead`: snapshot builds queued or running before this one                                                                                                                                                                                                                                                                                                                                                                   |
| `snapshot_build`      | `poll_cycle` | On every reload. `records_listed` (grant and group records the listing found), `records_read` (reads attempted; a record whose listing entry could not be read is listed but not read), `grants_active`, `groups`, `unreadable` (records left out or kept from an earlier read), `snapshot_unchanged` (bool: the same grants and groups as the last build), `list_work_ms` (the concurrent grant and group listing), `read_work_ms`, `parse_work_ms` |

`result` is `applied` when the cycle reloaded the snapshot, `skipped` when the
pull never ran (the gate stayed busy, or `stop()` ended the wait) and nothing
forced a reload, and `no_change` otherwise. Only a `skipped` cycle whose wait
`stop()` ended is `cancelled`; one that still applied a pending reload ends
`ok`. `stop()` never interrupts a running pull or reload, so a cycle that had
acquired the gate, or a local cycle, finishes `ok` with
`cancel_observed=true`. A failed cycle has the error's outcome and no `result`;
its failed child says where. A pull that times out ends `remote_pull` with
`timeout` and `poll_cycle` with `error`.

`reload_reason` says why a reload ran. `pending_retry` is a reload a failed
earlier cycle left behind. `unreadable_retry` rebuilds a snapshot that is
missing records it could not read (not corrupt ones, which never read by
themselves); `unreadable_records` counts those records.

The snapshot is always rebuilt; nothing is reused. `snapshot_unchanged` says
whether the rebuild produced the same policy, so a retry that changed nothing is
visible. `snapshot_queue_wait` is time spent behind other builds, such as the
debounced rebuild a local grant or group write sets off. That rebuild is not
exported: it belongs to no poll, so the queue wait is all of it a poll shows.
`list_work_ms` is one measurement of two concurrent listings; `read_work_ms`
and `parse_work_ms` are per-record and sequential. A first build that fails on
unreadable records keeps its counts and ends `error`.

Shared phases (`definition_lookup`, `lock_wait` and the rest) appear under a
pull or a build when the datastore or repository code they reach runs them.

Volume: an unchanged cycle exports two phases on a local source, three on a
sync pull with a gate, and a reload adds up to three more, whatever the size of
the catalog. At
the default 30-second interval that is about 2,880 cycles a day per instance.
`swamp.execution.*` metrics, when enabled, gain the seven `diagnostic.<phase>`
operation labels above.

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
| where isnotempty(area)
| summarize n=count(), p50_ms=percentile(ms,50), p95_ms=percentile(ms,95), max_ms=max(ms)
  by area, phase, outcome, version
| sort by p95_ms desc
```

The sync gate's tagged `gate_wait` has no `swamp.outcome`, so it groups under an
empty outcome; read `sync_gate.acquired` for whether the gate was taken. The
access poller's `gate_wait` has an outcome and `swamp.diagnostic.acquired`.

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

Run-detail outputs: what each slow history request spent its walk on. The walk
is sequential, so its `*_work_ms` values are disjoint and may be compared with
its duration; the remainder is `unattributed`:

```apl
let from = datetime(2026-10-26T00:00:00Z);
let to = datetime(2026-10-27T00:00:00Z);
['swamp-serve-traces']
| where _time between (from .. to)
| where ['service.name'] == 'swamp-serve-vm'
| where name == 'swamp.diagnostic.output_walk'
| extend a=['attributes.custom']
| extend outcome=tostring(a['swamp.outcome']),
         result=tostring(a['swamp.diagnostic.result']),
         walk_ms=duration/1ms,
         ownership_ms=todouble(a['swamp.diagnostic.owner_lookup_work_ms'])
           + coalesce(todouble(a['swamp.diagnostic.read_work_ms']), 0.0)
           + coalesce(todouble(a['swamp.diagnostic.parse_work_ms']), 0.0),
         decision_ms=todouble(a['swamp.diagnostic.authorize_work_ms']),
         read_ms=todouble(a['swamp.diagnostic.content_read_work_ms']),
         parse_ms=todouble(a['swamp.diagnostic.json_parse_work_ms']),
         child_ms=todouble(a['swamp.diagnostic.child_run_lookup_work_ms']),
         assemble_ms=todouble(a['swamp.diagnostic.assemble_work_ms'])
| extend ownership_ms=coalesce(ownership_ms, 0.0), decision_ms=coalesce(decision_ms, 0.0),
         read_ms=coalesce(read_ms, 0.0), parse_ms=coalesce(parse_ms, 0.0),
         child_ms=coalesce(child_ms, 0.0), assemble_ms=coalesce(assemble_ms, 0.0)
| extend top_ms=max_of(ownership_ms, decision_ms, read_ms, parse_ms, child_ms, assemble_ms)
| extend unattributed_ms=walk_ms - (ownership_ms + decision_ms + read_ms + parse_ms + child_ms + assemble_ms)
| extend dominant=case(
    unattributed_ms > top_ms, 'unattributed',
    ownership_ms == top_ms, 'ownership',
    decision_ms == top_ms, 'permission_decisions',
    read_ms == top_ms, 'content_reads',
    parse_ms == top_ms, 'parsing',
    child_ms == top_ms, 'nested_runs',
    'assembly')
| summarize n=count(), p50_ms=percentile(walk_ms,50), p95_ms=percentile(walk_ms,95),
            max_ms=max(walk_ms)
  by dominant, outcome, result
```

The sum is valid only within one `output_walk`, whose measurements never
overlap; never add `owner_index` or child spans to it, since
`owner_lookup_work_ms` already contains them.

Run-detail outputs: owner index cost and cache state against the resources and
bytes a request read:

```apl
let from = datetime(2026-10-26T00:00:00Z);
let to = datetime(2026-10-27T00:00:00Z);
let index = ['swamp-serve-traces']
  | where _time between (from .. to)
  | where ['service.name'] == 'swamp-serve-vm'
  | where name == 'swamp.diagnostic.owner_index'
  | extend a=['attributes.custom']
  | project trace_id, index_ms=duration/1ms,
            cache=tostring(a['swamp.diagnostic.cache']),
            definitions=toint(a['swamp.diagnostic.definitions']),
            files_parsed=toint(a['swamp.diagnostic.files_parsed']),
            joined=toint(a['swamp.diagnostic.dirs_joined']) > 0;
['swamp-serve-traces']
| where _time between (from .. to)
| where ['service.name'] == 'swamp-serve-vm'
| where name == 'swamp.diagnostic.output_walk'
| extend a=['attributes.custom']
| project trace_id, walk_ms=duration/1ms,
          outcome=tostring(a['swamp.outcome']),
          owner_ms=todouble(a['swamp.diagnostic.owner_lookup_work_ms']),
          owners=toint(a['swamp.diagnostic.owner_lookups']) - toint(a['swamp.diagnostic.owner_lookups_reused']),
          resources=toint(a['swamp.diagnostic.resources_attempted']),
          content_bytes=toint(a['swamp.diagnostic.content_bytes'])
| join kind=leftouter (index) on trace_id
| extend cache=iff(isnull(cache), 'no_index_check', cache)
| summarize n=count(), p95_walk_ms=percentile(walk_ms,95), p95_owner_ms=percentile(owner_ms,95),
            p95_index_ms=percentile(index_ms,95), avg_files_parsed=avg(files_parsed),
            max_definitions=max(definitions), avg_owners=avg(owners),
            avg_resources=avg(resources), p95_content_bytes=percentile(content_bytes,95)
  by cache, joined, outcome
```

A request with no `owner_index` row had no owner lookup, or ran without the
index; `joined` requests waited on another request's listing.

Worker deletion latency by phase, outcome and build:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| extend area=tostring(['attributes.custom']['swamp.diagnostic.area']),
         phase=tostring(['attributes.custom']['swamp.diagnostic.phase']),
         outcome=tostring(['attributes.custom']['swamp.outcome']),
         version=tostring(['resource.custom']['swamp.version']),
         ms=duration/1ms
| where area == 'worker_delete'
| summarize n=count(), p50_ms=percentile(ms,50), p95_ms=percentile(ms,95), max_ms=max(ms)
  by phase, outcome, version
| sort by p95_ms desc
```

Where each prune pass spent its time: selection, discovery and reference scans,
removal I/O, index and staging upkeep within the removals, or binding cleanup,
with the counts that explain them:

```apl
let from = datetime(2026-10-26T00:00:00Z);
let to = datetime(2026-10-27T00:00:00Z);
let service = 'swamp-serve-vm';
let stages = ['swamp-serve-traces']
  | where _time between (from .. to)
  | where ['service.name'] == service
  | extend a=['attributes.custom']
  | where tostring(a['swamp.diagnostic.area']) == 'worker_delete'
  | extend phase=tostring(a['swamp.diagnostic.phase']),
           ms=duration/1ms,
           upkeep=coalesce(todouble(a['swamp.diagnostic.catalog_update_work_ms']), 0.0)
                   + coalesce(todouble(a['swamp.diagnostic.latest_update_work_ms']), 0.0)
                   + coalesce(todouble(a['swamp.diagnostic.change_stage_work_ms']), 0.0)
                   + coalesce(todouble(a['swamp.diagnostic.tombstone_work_ms']), 0.0)
                   + coalesce(todouble(a['swamp.diagnostic.event_publish_work_ms']), 0.0)
  | summarize
      selection_ms=sumif(ms, phase in ('worker_listing','eligibility')),
      resolve_ms=sumif(ms, phase == 'definition_resolve'),
      reference_ms=sumif(ms, phase == 'workflow_reference_check'),
      data_discovery_ms=sumif(ms, phase in ('data_discovery','expiry_check')),
      output_discovery_ms=sumif(ms, phase == 'output_discovery'),
      removal_ms=sumif(ms, phase in ('output_removal','data_removal','evaluated_removal','definition_removal')),
      upkeep_ms=sumif(upkeep, phase in ('output_removal','data_removal','evaluated_removal','definition_removal')),
      binding_ms=sumif(ms, phase == 'binding_cleanup'),
      workers=sumif(toint(a['swamp.diagnostic.attempted']), phase == 'delete_loop'),
      definitions_read=sumif(toint(a['swamp.diagnostic.files_read']), phase == 'definition_resolve'),
      workflows_loaded=sumif(toint(a['swamp.diagnostic.workflows']), phase == 'workflow_reference_check'),
      outputs_read=sumif(toint(a['swamp.diagnostic.files_read']), phase == 'output_discovery'),
      outputs_deleted=sumif(toint(a['swamp.diagnostic.deleted']), phase == 'output_removal')
    by trace_id;
['swamp-serve-traces']
| where _time between (from .. to)
| where ['service.name'] == service
| where name == 'swamp.diagnostic.prune_pass'
| extend a=['attributes.custom']
| project trace_id, pass_ms=duration/1ms,
          outcome=tostring(a['swamp.outcome']),
          result=tostring(a['swamp.diagnostic.result'])
| join kind=leftouter (stages) on trace_id
| extend discovery_ms=resolve_ms + reference_ms + data_discovery_ms + output_discovery_ms
| extend top_ms=max_of(selection_ms, discovery_ms, removal_ms, binding_ms)
| extend dominant=case(
    top_ms == 0, 'unattributed',
    discovery_ms == top_ms, 'discovery',
    removal_ms == top_ms, 'removal',
    binding_ms == top_ms, 'binding_cleanup',
    'selection')
| project trace_id, outcome, result, dominant, pass_ms, workers,
          selection_ms, resolve_ms, reference_ms, data_discovery_ms, output_discovery_ms,
          removal_ms, upkeep_ms, binding_ms,
          definitions_read, workflows_loaded, outputs_read, outputs_deleted
| sort by pass_ms desc
```

The selection is by the pass's start, so a pass that runs past the window's end
is kept whole with the window it started in. Every column but `upkeep_ms` sums
spans of one kind that never overlap within a pass, so each is that kind's share
of the pass's wall time, and `discovery_ms` adds kinds that run one after
another. `upkeep_ms` is summed `*_work_ms` inside the removal phases: it is part
of `removal_ms`, never added to it. The four compared columns leave out the
per-worker time outside the stages, which is each `model_delete`'s
`swamp.phase.uncovered_ms`. Failed, cancelled and partial passes stay separate
rows through `outcome` and `result`. `definitions_read`, `workflows_loaded` and
`outputs_read` divided by `workers` show discovery repeated per worker.

Refused and failed worker deletes, by reason:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| where name == 'swamp.diagnostic.model_delete'
| extend a=['attributes.custom']
| extend outcome=tostring(a['swamp.outcome']),
         refusal=tostring(a['swamp.diagnostic.refusal']),
         ms=duration/1ms
| summarize n=count(), p95_ms=percentile(ms,95), max_ms=max(ms) by outcome, refusal
```

Output retention, scan against deletion: one row per batch, with its stages'
elapsed time and the scan's eligibility and deletion work. The stages of a
batch are sequential, so their sum is part of the batch's wall time, and
`other_ms` is the rest. Inside `candidate_scan` only the two work sums are
compared; they are summed per item and never added to elapsed time.

```apl
let from = datetime(2026-10-26T00:00:00Z);
let to = datetime(2026-10-27T00:00:00Z);
let service = 'swamp-serve-vm';
let stages = ['swamp-serve-traces']
  | where _time between (from .. to)
  | where ['service.name'] == service
  | extend a=['attributes.custom']
  | where tostring(a['swamp.diagnostic.area']) == 'output_retention'
  | extend phase=tostring(a['swamp.diagnostic.phase']), ms=duration/1ms,
           considered=toint(a['swamp.diagnostic.considered']),
           scan_deleted=toint(a['swamp.diagnostic.deleted']),
           eligibility_work=coalesce(todouble(a['swamp.diagnostic.stat_work_ms']), 0.0)
             + coalesce(todouble(a['swamp.diagnostic.read_work_ms']), 0.0)
             + coalesce(todouble(a['swamp.diagnostic.parse_work_ms']), 0.0),
           deletion_work=coalesce(todouble(a['swamp.diagnostic.remove_work_ms']), 0.0)
             + coalesce(todouble(a['swamp.diagnostic.dir_cleanup_work_ms']), 0.0)
             + coalesce(todouble(a['swamp.diagnostic.tombstone_work_ms']), 0.0)
  | where phase != 'retention_batch'
  | summarize
      gate_ms=sumif(ms, phase == 'gate_wait'),
      listing_ms=sumif(ms, phase == 'candidate_enumeration'),
      scan_ms=sumif(ms, phase == 'candidate_scan'),
      sweep_ms=sumif(ms, phase == 'orphan_log_sweep'),
      commit_ms=sumif(ms, phase == 'batch_commit'),
      eligibility_work_ms=sumif(eligibility_work, phase == 'candidate_scan'),
      deletion_work_ms=sumif(deletion_work, phase == 'candidate_scan'),
      considered=sumif(considered, phase == 'candidate_scan'),
      deleted=sumif(scan_deleted, phase == 'candidate_scan')
    by batch=parent_span_id;
['swamp-serve-traces']
| where _time between (from .. to)
| where ['service.name'] == service
| where name == 'swamp.diagnostic.retention_batch'
| project _time, trace_id, batch=span_id, batch_ms=duration/1ms,
          outcome=tostring(['attributes.custom']['swamp.outcome'])
| join kind=leftouter (stages) on batch
| extend other_ms=batch_ms - gate_ms - listing_ms - scan_ms - sweep_ms - commit_ms
| extend dominant=case(
    gate_ms >= max_of(listing_ms, scan_ms, sweep_ms, commit_ms), 'gate_wait',
    listing_ms >= max_of(scan_ms, sweep_ms, commit_ms), 'listing',
    commit_ms >= max_of(scan_ms, sweep_ms), 'commit_push',
    sweep_ms >= scan_ms, 'orphan_log_sweep',
    eligibility_work_ms >= deletion_work_ms, 'scan_eligibility',
    'scan_deletion')
| project _time, trace_id, outcome, dominant, batch_ms, gate_ms, listing_ms, scan_ms,
          eligibility_work_ms, deletion_work_ms, sweep_ms, commit_ms, other_ms,
          considered, deleted
| sort by batch_ms desc
```

`dominant` names a batch's largest stage, and splits the scan by which work
sum is larger. A batch from a build without the phases has no
`retention_batch` span and so no row; select its `swamp.retention.batch` span
instead. To summarise a window, follow it with
`| summarize n=count(), p50_ms=percentile(batch_ms,50), p95_ms=percentile(batch_ms,95), max_ms=max(batch_ms) by dominant, outcome`.

Access polls: phase latency by phase, source mode, outcome and build:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| extend a=['attributes.custom']
| where tostring(a['swamp.diagnostic.area']) == 'access_poll'
| extend phase=tostring(a['swamp.diagnostic.phase']),
         mode=tostring(a['swamp.diagnostic.source_mode']),
         outcome=tostring(a['swamp.outcome']),
         version=tostring(['resource.custom']['swamp.version']),
         ms=duration/1ms
| summarize n=count(), p50_ms=percentile(ms,50), p95_ms=percentile(ms,95), max_ms=max(ms)
  by phase, mode, outcome, version
| sort by p95_ms desc
```

One poll's breakdown is the single-trace query above, with the `trace_id` of a
`swamp.serve.poll` span.

Which stage dominated each access poll: a file scan, gate contention, a slow
pull, waiting behind another snapshot build, or the build itself:

```apl
let from = datetime(2026-10-26T00:00:00Z);
let to = datetime(2026-10-27T00:00:00Z);
let stages = ['swamp-serve-traces']
  | where _time between (from .. to)
  | where ['service.name'] == 'swamp-serve-vm'
  | extend a=['attributes.custom']
  | where tostring(a['swamp.diagnostic.area']) == 'access_poll'
  | extend phase=tostring(a['swamp.diagnostic.phase']), ms=duration/1ms
  | summarize detect_ms=sumif(ms, phase == 'change_detection'),
              gate_ms=sumif(ms, phase == 'gate_wait'),
              pull_ms=sumif(ms, phase == 'remote_pull'),
              queue_ms=sumif(ms, phase == 'snapshot_queue_wait'),
              build_ms=sumif(ms, phase == 'snapshot_build')
    by trace_id;
['swamp-serve-traces']
| where _time between (from .. to)
| where ['service.name'] == 'swamp-serve-vm'
| where name == 'swamp.diagnostic.poll_cycle'
| extend a=['attributes.custom']
| project trace_id, cycle_ms=duration/1ms,
          mode=tostring(a['swamp.diagnostic.source_mode']),
          reason=tostring(a['swamp.diagnostic.reload_reason']),
          result=tostring(a['swamp.diagnostic.result']),
          outcome=tostring(a['swamp.outcome'])
| join kind=leftouter (stages) on trace_id
| extend detect_ms=coalesce(detect_ms, 0.0), gate_ms=coalesce(gate_ms, 0.0),
         pull_ms=coalesce(pull_ms, 0.0), queue_ms=coalesce(queue_ms, 0.0),
         build_ms=coalesce(build_ms, 0.0)
| extend dominant=case(
    detect_ms >= max_of(gate_ms, pull_ms, queue_ms, build_ms), 'change_detection',
    gate_ms >= max_of(pull_ms, queue_ms, build_ms), 'gate_wait',
    pull_ms >= max_of(queue_ms, build_ms), 'remote_pull',
    queue_ms >= build_ms, 'snapshot_queue_wait',
    'snapshot_build')
| summarize n=count(), p50_ms=percentile(cycle_ms,50), p95_ms=percentile(cycle_ms,95),
            max_ms=max(cycle_ms)
  by mode, dominant, reason, result, outcome
```

Each poll is its own trace with one `poll_cycle`, and its stages run one after
another, so each column is that stage's share of the cycle's wall time. The
columns are compared, never added. A local poll has no gate or pull and a sync
poll no detection; their columns are zero, not missing work. Catalog
invalidation is in-memory and is left out of the comparison; the cycle's
`swamp.phase.uncovered_ms` holds it and the cycle's own work.

Gate contention on sync pulls: how often the poller waited, skipped or queued:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| where name == 'swamp.diagnostic.gate_wait'
| extend a=['attributes.custom']
| where tostring(a['swamp.diagnostic.area']) == 'access_poll'
| extend gate_mode=tostring(a['swamp.diagnostic.gate_mode']),
         acquired=tobool(a['swamp.diagnostic.acquired']),
         attempts=toint(a['swamp.diagnostic.attempts']),
         outcome=tostring(a['swamp.outcome']),
         ms=duration/1ms
| summarize n=count(), p95_ms=percentile(ms,95), max_ms=max(ms), max_attempts=max(attempts)
  by gate_mode, acquired, outcome
```

Snapshot builds against the size of the access catalog:

```apl
['swamp-serve-traces']
| where _time between (datetime(2026-10-26T00:00:00Z) .. datetime(2026-10-27T00:00:00Z))
| where ['service.name'] == 'swamp-serve-vm'
| where name == 'swamp.diagnostic.snapshot_build'
| extend a=['attributes.custom']
| where tostring(a['swamp.diagnostic.area']) == 'access_poll'
| extend records=toint(a['swamp.diagnostic.records_read']),
         unreadable=toint(a['swamp.diagnostic.unreadable']),
         unchanged=tobool(a['swamp.diagnostic.snapshot_unchanged']),
         list_ms=todouble(a['swamp.diagnostic.list_work_ms']),
         read_ms=todouble(a['swamp.diagnostic.read_work_ms']),
         outcome=tostring(a['swamp.outcome']),
         ms=duration/1ms
| extend records_bucket=bin(records, 100), has_unreadable=unreadable > 0
| summarize n=count(), p50_ms=percentile(ms,50), p95_ms=percentile(ms,95), max_ms=max(ms),
            max_records=max(records), avg_list_work_ms=avg(list_ms),
            avg_read_work_ms=avg(read_ms)
  by records_bucket, unchanged, has_unreadable, outcome
```

## What this does not establish

`integration/worker_enroll_phase_telemetry_test.ts` drives a real gateway
through the real OTLP exporter. It checks that names, parent ids, value types,
outcomes and statuses survive export for new, existing, contended, cancelled and
failed enrollments, and that an enrollment's phase count is the same with a
small and a large worker catalog.

`integration/step_outputs_phase_telemetry_test.ts` drives the real
`workflow.history.get` handler, policy authorization and definition index
through the real OTLP exporter. It checks names, parent ids, value types,
outcomes, statuses and known counts for allowed, denied, missing, unparseable
and non-object outputs, nested and missing child runs, two requests sharing one
index listing (and its span link), cancellation before and during the walk, a
failed owner lookup, that the span count does not grow with 200 definitions or
40 outputs, and that a request answers the same with tracing off. The run-detail
queries have not been run against Axiom; that is evidence collected after
deployment.

`integration/worker_delete_phase_telemetry_test.ts` drives a real prune over
real worker definitions, data, outputs and a referencing workflow through the
same exporter. It checks parentage, value types, outcomes and statuses, the
fixture counts for eligible, skipped, deleted and refused workers, a consumer
stopping part way, that no phase carries a worker name, token name or path, and
that a prune's span count is the same with 1 and with 25 outputs. The token
listing and binding prune are stubbed there; the deletions are real.

`integration/output_retention_phase_telemetry_test.ts` runs real retention
passes, each batch wrapped as serve wraps it, through the real OTLP exporter.
It checks that names, parent ids, value types, outcomes and statuses survive
export for a mixed batch (eligible, protected and unexpired outputs), an empty
batch and one that fails after removing some outputs, and that a batch's span
count is the same for 10 and 300 outputs.

`integration/access_poll_phase_telemetry_test.ts` does the same for access
polls. It runs the real poller, change source, policy snapshot loader and sync
gate, with an in-process sync service on the sync-pull branch. It covers
unchanged and changed polls, corrupt and unreadable records, skipped,
failed, timed-out and stopped pulls, and checks that a poll's phase count is the
same with 2 and 300 grants and that no attribute names a path, a record id or
record content. Overhead was not measured, and the access poll queries have not
been run against a dataset.

Against production `swamp-serve-traces` (2026-10-27, build `b4dd513d`, before
the enrollment phases shipped), the field paths and types above were confirmed
on real enrollment spans. The phase-latency, single-trace, worker-lookup and
cancellation queries parsed and ran. The dominance query is too complex for
Axiom's legacy result format and needs the tabular format (the query editor or
`format=tabular`). The output-retention queries have not been run against
Axiom. Running these queries on exported phase spans in a test
dataset, and measuring overhead on a deployed server, is evidence collected
after deployment.

The worker deletion queries have not been run against any dataset: there is no
Axiom test dataset or test environment, and no worker deletion phase has been
exported to Axiom yet. They use only the field paths, casts and constructs of
the enrollment queries above. No production trace ID is given for them. Whether
they answer the 50-minute prune is evidence collected after deployment.
