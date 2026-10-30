# Output summary index

History reads list runs: `model.output.search`, the output and method history
searches, `swamp summarise`. Each needs about ten fields per run, and reading them from
the output records means opening one YAML file per run in the window. The output
summary index (lab #4145) answers those reads from a compact cache, so their cost
stops growing with the runs in the window.

The YAML records stay the only truth. The index can be deleted at any time, and
the next reads rebuild what they need.

## What it stores

Shards live at
`.swamp/_output_summaries/v1/<hash of the records root>/<normalized type>/<YYYY-MM-DD>.ndjson`,
one per type and UTC day of the file name's stamp. Each line is an `OutputSummary`:
id, definition id, method, status, start, duration, and what triggered the run
(trigger, workflow id, workflow run id, step name).

- **Checkout-local.** The directory is outside every materialised and synced
  subdirectory, so it is never committed, pushed or swept by a v3 recovery. Each
  checkout warms its own, including one that shares a datastore with others.
- **Finished runs only.** A finished record never changes, because `ModelOutput`
  moves only out of `pending` and `running`. A running output has no row and is
  read from its record every time.
- **No error messages.** A run's error text stays in its record, so retention has
  only the record to remove. `swamp summarise`, which shows the text, reads the
  record of each run that did not succeed.

## How a read uses it

A read lists file names exactly as it did without the index: registered types, in
walk order, leaving out names outside its window, and asking `selectReadable`
about the key each name carries. Then, for each file chosen:

1. A row whose key matches the file answers for it. A row's key comes from its
   own definition id, method and start, so it can only stand in for a file whose
   location says the same.
2. Anything else reads the record: no row, a torn line, a name not in the output
   form, a running output, or a record that disagrees with its location. A
   finished record whose location agrees gets a row for the next read.

A read opens a shard only when it is not much larger than what the read wants
from it: past 16 KiB per wanted file, it reads those records instead and adds no
rows. One model's few runs therefore cost what they did without the index, and a
limited search's small batches do not parse a whole day of a type.

Shards are read lazily and rows are added per batch of 1,024 records, so a scan
cancelled on a cold index keeps the batches it finished, losing only the one in
flight. The search's authorization is unchanged: the same keys
are judged before the reads, and the same final check runs on what comes back.

Callers that need a run's content (`output get`, logs, data, delete) still read
records through `findAllGlobal`, `findById` and `findByDefinition`.

The listing is the part that still grows: with retained runs, not with the
window. It is what keeps results identical to reading every record, because a
file the listing does not find is never returned, and a file with no row is read.

## How it heals

A write is one append and never fails the caller. Every way the index can fall
behind costs reads, not wrong answers:

| What happened                       | What the next read does                   |
| ----------------------------------- | ----------------------------------------- |
| Crash between record write and row  | Reads the record, adds the row            |
| Torn line, deleted or lost shard    | Reads those records, adds the rows        |
| Write from another checkout or pull | Reads the new record, adds the row        |
| Delete, GC or retention             | Finds no file, so never returns the row   |
| Index unwritable                    | Reads records, as it did without an index |

Two things do write back:

- **Retention.** A pass's final batch drops rows whose record is gone, and shards
  left empty, from shards more than two days old. Newer shards are left alone,
  because a record saved after the pass listed its files would lose its row. With
  retention off, rows of deleted runs stay on disk until the shard is rebuilt.
  They are never returned.
- **Recovery and restore.** A v3 recovery or a replica restore that moves the read
  model can put back the committed version of a record whose later save already has
  a row, and a finished row is never checked against its record. So whatever
  rewinds records removes the summaries afterwards, whether or not it succeeded,
  which `integration/output_summary_rules_test.ts` pins. `swamp doctor datastores`
  repair removes them as well. A read holding records from before a clear does not
  add them back: `removeStaleOutputSummaries` first moves a generation marker, and
  a backfill or a compaction that sees it moved skips its write, and a newest-first
  read drops the shards it holds.

## Known limits

- **Rewriting a finished record by hand.** The row keeps the old values until a
  recovery or a doctor repair removes the index.
- **Two runs in the same millisecond.** Two runs of one definition and method
  started in the same millisecond share a file name, so the later write replaces
  the earlier record. If the later one is still running, or was written by another
  checkout, the earlier row can outlive it until the index is removed.
- **Order of two finishes.** Two finished saves of one output can append in the
  opposite order to their record writes. That needs a cancel or a reaper to race
  a live owner, and both check the owner is gone first.

- **A clear racing an append.** A backfill compares the generation just before it
  appends, so a clear landing in that gap, one file operation wide, can leave a row
  of a rewound record.
- **Step names outlive their record.** A row keeps the step name, and a `forEach`
  name can carry an item value, with secrets already scrubbed. Rows of deleted runs
  stay until a retention pass compacts their shard, and a recent shard or a repo
  with retention off keeps them longer. They are never returned.
- **Old record roots.** Each records root has its own shards, keyed by a hash of its
  path. After a datastore path changes, the old root's shards stay on disk until a
  recovery or doctor repair clears the directory. They cost only disk.

## Where to look

- `src/domain/models/output_summary.ts`: the value object and its stored form
- `src/infrastructure/persistence/output_summary_index.ts`: shards
- `readSummaries` in `src/infrastructure/persistence/yaml_output_repository.ts`:
  the join of listing and rows
- `integration/output_summary_index_property_test.ts`: index-backed searches
  return what reading every record returns
- `candidate_scan` in [serve phase telemetry](./serve-phase-telemetry.md): the
  counters that show a read used it
