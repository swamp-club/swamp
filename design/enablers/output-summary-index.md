# Output summary index

History reads list runs: `model.output.search`, `model.usage.summary`, the output
and method history searches, `swamp summarise`. Each needs about ten fields per run, and reading them from
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
(trigger, workflow id, workflow run id, step name), with the fingerprint of the
record it was made from (mtime, size, and ctime and inode where the platform has
them), as a workflow run index entry has.

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

1. A row whose key matches the file, and whose fingerprint matches a stat of the
   file now, answers for it. A row's key comes from its own definition id, method
   and start, so it can only stand in for a file whose location says the same.
2. Anything else reads the record: no row, a torn line, a name not in the output
   form, a running output, a record that disagrees with its location, or one whose
   stat moved. So a damaged record is left out, as it is without the index and as
   `output get` finds it. A finished record whose location agrees gets a row for
   the next read, its fingerprint taken before the read, so a record replaced in
   between has a row that does not match it.

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

The stats grow with the files a read answers, about a quarter of a warm read's
time. Records under the checkout's own `.swamp`, as on a v3 datastore or with no
datastore, are stat'ed synchronously, because an awaited stat waits a turn of a busy
loop: on a contended loop 75,000 of them took 5 s awaited and 0.3 s synchronously.
Records anywhere else, including through a symlink, are in a datastore that may be a
network mount, so those are awaited, 16 at a time on the scan permits. There a slow
or hung mount costs the scan, not the event loop, and a busy loop costs that read
more. A checkout that is itself on a network mount still stats synchronously: there
a slow mount slows the read, and a hung one holds the loop.

So that a large read does not hold up the requests beside it, the stats, the shard
parse and the join of rows to files all yield to the event loop every 4 ms, and
stop at the next yield once the read is cancelled. A shard is decoded 1 MiB at a
time, so its size is not limited by what one string can hold. With 75,000 runs in
one shard, this took a warm read's longest block from about 250 ms to about 170 ms,
which is the listing's own sort and name matching, and added about 20% to its time.

## How it heals

A write is one append and never fails the caller. Every way the index can fall
behind costs reads, not wrong answers:

| What happened                       | What the next read does                   |
| ----------------------------------- | ----------------------------------------- |
| Crash between record write and row  | Reads the record, adds the row            |
| Torn line, deleted or lost shard    | Reads those records, adds the rows        |
| Record damaged, edited or put back  | Stat moved: reads the record              |
| Readers racing on a cold index      | Rewrites the shard with one row per key   |
| Write from another checkout or pull | Reads the new record, adds the row        |
| Delete, GC or retention             | Finds no file, so never returns the row   |
| Index unwritable                    | Reads records, as it did without an index |

Three things do write back:

- **Retention.** A pass's final batch drops rows whose record is gone, and shards
  left empty, from shards more than two days old. Newer shards are left alone,
  because a record saved after the pass listed its files would lose its row. With
  retention off, rows of deleted runs stay on disk until the shard is rebuilt.
  They are never returned.
- **Duplicates.** Readers racing on a cold index each add the same rows, since
  they share no scan across processes or read kinds. A read that finds a shard at
  least half made of lines that lost to another, or are not rows, rewrites it with
  the winners, unless the shard grew since it was read, so readers still adding
  rows keep them. Each dropped line took an append to add, so this costs a read at
  most once per doubling of the shard. A shard too large for a read to open waits
  for one that opens it.
- **Recovery and restore.** A v3 recovery or a replica restore that moves the read
  model can put back the committed version of a record whose later save already has
  a row. That record's stat has moved, so the row no longer answers, but whatever
  rewinds records still removes the summaries afterwards, whether or not it
  succeeded, as a second guard and to free the disk, which
  `integration/output_summary_rules_test.ts` pins. `swamp doctor datastores` repair
  removes them as well. A clear moves a generation marker first, and a backfill or
  a compaction that sees it moved skips its write, and a newest-first read drops the
  shards it holds. It then renames the shards aside and removes them from there: a
  read adding a file to a directory while a removal empties it would fail the
  removal, and no writer knows the name it moved to. A removal that still fails
  costs only disk, and the next clear retries it. Clears can overlap: an entry
  another clear moved first is that clear's to remove.

## Known limits

- **A write the stat cannot see.** Two writes to a record in one millisecond at
  one size, or a platform with only mtime and size restoring both, look like one
  version. A run's record is replaced whole, so the inode tells them apart wherever
  there is one.
- **Order of two finishes.** A save stats its record just after writing it, and
  keeps no row if the size is not what it wrote. Another save of that output
  landing in between, at the same size, leaves this save's values under the other's
  stat. That needs a cancel or a reaper to race a live owner, and both check the
  owner is gone first.
- **Two runs in the same millisecond.** Two runs of one definition and method
  started in the same millisecond share a file name, so the later write replaces
  the earlier record and the earlier run is lost, as it is without the index.
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
