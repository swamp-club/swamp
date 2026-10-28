---
audience: maintainer
enables: [data]
last-verified: 2026-10-13 @ 35be0b9d
---

# Datastore: Litestream Replication

How swamp runs [Litestream](https://litestream.io) to replicate `commits.db`,
the single-writer SQLite database at the centre of the v3 datastore (tracking:
swamp-club#2865). This is the decision record from the Phase 3 spike
(swamp-club#3234). It says how Litestream is shipped, run and talked to, and
what the commit store, the outbox and failover can rely on. Nothing here is
built yet. Phase 4 (solo mode, the CLI's embedded datastore service) and Phase 5
(team mode, the elected `swamp serve` leader) build on it.

See [datastores.md](./datastores.md) for today's sync model, the format marker
and the `_control/` records this layout sits beside.

## Decision

> **Resolved (swamp-club#3358):** the 2026-10-11 decision to download rather
> than embed Litestream is built, and decision 1 below now records it.
> Embedding with `deno compile --include` would add about 38 MB to every
> release for every user. It is revisited at Phase 7, when v3 becomes the
> default.

1. **Run the upstream `litestream` binary as a sidecar process that swamp
   supervises, downloaded on first v3 use.** See
   [Obtaining the binary](#obtaining-the-binary).
2. **Talk to it through its control socket.** `POST /sync {"wait": true}` is how
   a writer learns that a commit has reached the bucket (see
   [Knowing a commit is replicated](#knowing-a-commit-is-replicated)).
3. **One sidecar per datastore writer, kept alive between commands.** In solo
   mode a write command reuses an idle sidecar, or starts one, and forces a
   sync before it exits; the sidecar exits after an idle timeout. A sidecar per
   command was the starting point, and Phase 4A replaced it (see
   [Phase 4A](#phase-4a-replication-cost-on-a-bucket-model-swamp-club3357)).
   In team mode the serve leader keeps one running for as long as it holds the
   lease.
4. **`commits.db` keeps SQLite's default checkpointing and never forces a
   checkpoint.** Do not copy `catalog_store.ts`'s `wal_checkpoint(TRUNCATE)`
   pattern.
5. **One replica path per writer lineage.** `<prefix>/_litestream/<fence>/`,
   named by the fence at which the lineage's replication began: in solo mode
   one checkout's run of commands, not each command's own fence (see
   [What changes for Phase 4D and 4E](#what-changes-for-phase-4d-and-4e)); in
   team mode the serve leader's fence. Litestream 0.5 has no generations, and
   a second writer on the same path corrupts the replica.
6. **Windows: a supported target, gated on an upstream fix.** Litestream 0.5.16
   and 0.5.17 cannot replicate on Windows (litestream#1542, fixed on main by
   #1548, not yet released). Deno has no AF_UNIX client on Windows, so swamp
   reaches the socket there through `litestream sync`. Phase 4 must not pin a
   build from main. See [Windows and macOS](#windows-and-macos-q7).

## Why a sidecar

Four options were prototyped or assessed. All measurements are in
[Measurements](#measurements).

| Option                                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sidecar binary** (chosen)                                                                          | Upstream builds it for every target swamp ships. It runs in its own process, so a Litestream crash can't take swamp down, and it uses its own copy of SQLite in its own process. swamp writing `commits.db` through `node:sqlite` while the sidecar reads it through its own SQLite, in a separate process, is Litestream's normal, supported model. Only a second copy inside swamp's process is unsafe. It adds 36–40 MB per target. Startup to a ready socket takes 13–19 ms on Linux and Apple silicon.                                                                                                                                                                                                                                                                                                                                            |
| **Go library, c-shared, via `Deno.dlopen`**                                                          | It works: dlopen took 4 ms, a sync 13 ms, and Deno's signal handling still worked. Rejected for three reasons. It loads a **second copy of SQLite into swamp's process**: Litestream uses `modernc.org/sqlite`, and `node:sqlite` bundles its own. Two copies on one file share POSIX advisory locks but not SQLite's bookkeeping, and closing a file in one silently drops the other's locks. That is a known way to corrupt a database ([sqlite.org/howtocorrupt §2.2.1](https://www.sqlite.org/howtocorrupt.html#_multiple_copies_of_sqlite_linked_into_the_same_application)). A Go panic would also kill swamp. And swamp would have to own a cgo cross-build for each of its five targets. `dlopen` needs a real file anyway, so it still has to be extracted like a sidecar. It saves only about 8 MB (29.5 MB stripped dylib against 37.5 MB). |
| **TypeScript reimplementation of WAL shipping**                                                      | Rejected. Litestream's core is about 7.4k lines of Go, plus 1.9k for the LTX format and 2.6k for the S3, GCS and file clients. The hard parts are correctness under concurrent checkpoints, WAL salt changes and snapshot boundaries, and the code cites several production bugs it has fixed there. `node:sqlite` has no WAL hook, so a reimplementation would read the `-wal` file behind SQLite's back. Revisit only if the sidecar can't ship.                                                                                                                                                                                                                                                                                                                                                                                                     |
| **LiteFS**                                                                                           | Rejected on paper. It is a FUSE filesystem, so it is Linux-only and needs mount privileges. swamp ships to macOS and Windows and runs unprivileged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **SQLite session extension** (`createSession` / `applyChangeset`, available in Deno's `node:sqlite`) | Not chosen. Changesets are logical diffs, so swamp would have to design its own log format, ordering, snapshots and restore, which amounts to writing a replicator. It stays as the fallback if Windows can't be supported (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Licensing: Litestream is Apache-2.0. swamp's release binaries don't carry it:
each machine fetches upstream's own release, and the cache keeps upstream's
`LICENSE` beside the binary. The serve Docker image does redistribute it, so
Apache-2.0 §4 applies there: the image ships upstream's `LICENSE` at
`/usr/share/doc/litestream/LICENSE`. Upstream ships no NOTICE file.

## Obtaining the binary

Built in swamp-club#3358, dormant until the sidecar uses it. The code is
`src/domain/datastore_v3/litestream_release.ts` (the rules) and
`src/infrastructure/datastore_v3/litestream/` (the pin and the provider).

- **Pinned at build time.** `litestream_pin.ts` records one version and, for
  darwin-arm64, darwin-x86_64, linux-arm64, linux-x86_64 and windows-x86_64,
  the SHA-256 of upstream's archive and of the binary inside it.
  `deno run litestream-pin --version <v>` regenerates it from upstream's
  `checksums.txt`, checking every archive against it and hashing every binary.
  It also rewrites the Dockerfile's copy of the linux archive digests.
  `deno run litestream-pin --check` re-derives the pin and fails on drift. The
  same check runs as an opt-in test when `SWAMP_LITESTREAM_NETWORK_TEST` is set.
- **Downloaded on first use** from upstream's GitHub release for that version
  and target. The archive is read under a 128 MB cap and a 10-minute timeout
  and hashed **before** anything is extracted. The binary is hashed again
  after extraction. Only the binary and `LICENSE` are kept.
- **Cached per version** at `<swamp data dir>/litestream/<version>/`
  (`~/.swamp/` unless `SWAMP_HOME` is set), so two swamp versions on one
  machine never share a binary.
- **Hashed before every start.** The binary sees bucket credentials and every
  commit, so the provider hashes it on every call, which costs about 14 ms on
  37 MB. A version directory whose binary is missing or doesn't match is
  refused, never replaced or run: the error names the directory to delete.
- **Concurrent first use takes no lock.** Each process stages its download
  in its own temp directory beside the cache and renames it into place, so N
  racing processes each download the archive once; this happens once per
  version. A
  rename onto an existing directory fails on every platform, so the first
  rename wins. The other process discards its copy and hashes the winner's.
  Staging directories older than 10 minutes, left by a crashed process, are
  swept on the next download.
- **Offline and air-gapped machines.** `SWAMP_LITESTREAM_PATH` points at a
  binary the user installed. It is hashed against the pin like any other.
  With no network and no override, the error says what failed (network error,
  timeout or HTTP status), the exact URL, both digests, and the two places
  the binary can go: the cache path or `SWAMP_LITESTREAM_PATH`. On macOS it
  says to download with `curl`, because a browser download is quarantined and
  Gatekeeper may stop it. A binary placed in the cache by hand is made
  executable once its hash matches; an override path is never modified.
- **The serve Docker image** fetches the linux archive at build time
  (`ADD --checksum`, one stage per architecture), installs
  `/usr/local/bin/litestream` and sets `SWAMP_LITESTREAM_PATH` to it, so serve
  never downloads at runtime. `integration/toolchain_pins_rules_test.ts` fails
  if the Dockerfile and the pin drift apart.
- **Windows** needs Litestream 0.5.18 or later (litestream#1542). Below it the
  provider reports that v3 replication isn't available on Windows yet, and
  Windows stays on v2. With 0.5.17 pinned, that is the case today.

## Measurements

Litestream 0.5.17 (Windows: see [its section](#windows-and-macos-q7)), Deno
2.9.7. "Local" means Apple M-series, macOS. CI means GitHub-hosted runners. S3
means ministack and GCS means fake-gcs-server. "+30 ms RTT" puts a proxy in
front of the emulator that adds one 30 ms round trip per request and two more on
each new connection, as a stand-in for TCP and TLS. **All bucket figures come
from emulators**: they show request counts and shape, not real-bucket latency.
Expect real buckets to look like the RTT rows or worse.

### Binary size

|                                                            | Bytes                         |
| ---------------------------------------------------------- | ----------------------------- |
| `litestream` darwin-arm64 / darwin-x86_64                  | 37.6 M / 40.1 M               |
| `litestream` linux-arm64 / linux-x86_64                    | 36.2 M / 39.0 M               |
| `litestream.exe` windows-x86_64                            | 40.0 M                        |
| `deno compile --include` delta for the darwin-arm64 binary | +37.8 M (1:1, not compressed) |
| swamp release binaries today (v20261010.215801.0)          | 314–381 M (+10–12 %)          |
| Go c-shared dylib, stripped (option b)                     | 29.5 M                        |

### Startup and per-command cost

A per-command sidecar does: spawn, wait for the socket, write 5 commits, force a
sync, then SIGTERM. Times are p50 in ms. "Forced sync" is one commit followed by
`/sync wait`.

| Target                                   | Ready | Forced sync | Whole command | Long-lived forced sync |
| ---------------------------------------- | ----- | ----------- | ------------- | ---------------------- |
| file, local                              | 14.0  | 13.9        | 29.7          | 14.9                   |
| file, ubuntu-latest (x86_64)             | 12.7  | 2.6         | 17.4          | 1.4                    |
| file, ubuntu-24.04-arm                   | 19.4  | 3.6         | 25.9          | 1.9                    |
| file, macos-15-intel                     | 66.4  | 24.5        | 103.2         | 19.1                   |
| file, windows-latest (amd64, `93ba3cd7`) | 82.1  | 47.6        | 138.2         | 43.2                   |
| file, windows-11-arm (`93ba3cd7`)        | 51.5  | 51.0        | 112.1         | 44.8                   |
| S3, local                                | 13.9  | 11.3        | 26.8          | 9.2                    |
| S3 +30 ms RTT, local                     | 28.1  | 164.7       | 196.8         | 43.8                   |
| GCS, local                               | 13.9  | 12.2        | 28.3          | 11.4                   |

The first run of a newly extracted binary on macOS took 240–380 ms, against
13–17 ms for later runs. This is the OS checking a new executable, and it is
paid once per version. Extracting the binary from the compiled swamp binary took
12 ms and hashing it 14 ms. A forced sync to a local file costs more on macOS
(14 ms) than on Linux (2–4 ms). Litestream's syncs (Go's `File.Sync`) are
`F_FULLFSYNC` on macOS; SQLite's are not: `node:sqlite` runs with
`PRAGMA fullfsync=0` and `checkpoint_fullfsync=0`, and swamp sets neither, so
they are plain `fsync` there (checked for
swamp-club#3617 with Deno 2.9.7, in memory and on a WAL file).

**Passive lag**, with no forced sync and the defaults `monitor-interval: 1s` and
`sync-interval: 1s`: p50 650–690 ms and p90 0.69–1.95 s, from commit to the
replica showing the new TXID, on every target. The probe polls with
`litestream ltx`, so add about 20 ms of resolution.

### Restore

`litestream restore` onto a fresh path, then `PRAGMA integrity_check` and a
row-for-row count. The data is 4 KB rows.

| DB size | file, local | S3, local | S3 +30 ms RTT | file, ubuntu x86_64 | file, macos-intel |
| ------- | ----------- | --------- | ------------- | ------------------- | ----------------- |
| 1 MB    | 23 ms       | 47 ms     | 1.21 s        | 21 ms               | 72 ms             |
| 100 MB  | 0.49 s      | 0.48 s    | 1.66 s        | 1.10 s              | 1.48 s            |
| 1 GB    | 4.47 s      | 4.57 s    | —             | —                   | —                 |

Every restore passed the integrity check and matched row for row. Under RTT a
fixed cost of about 1.2 s dominates small databases, because restore lists each
compaction level before it downloads. A standby running `litestream restore -f`
(follow mode) stayed p50 170–205 ms behind each forced sync on every target,
except Windows before 0.5.18 (see below).

### Checkpoint regimes (Q2)

20,000 commits of 2 KB each (82 MB), with a forced sync every 500 commits, run
twice per regime. All four regimes restored correctly. They differ in cost:

| App-side checkpointing                                | Replica size / DB size | Restore                                     |
| ----------------------------------------------------- | ---------------------- | ------------------------------------------- |
| SQLite default (PASSIVE auto-checkpoint, 1000 pages)  | 1.0×                   | 0.39 s                                      |
| Auto-checkpoint off (Litestream does all checkpoints) | 1.0×                   | 0.39 s                                      |
| App runs `wal_checkpoint(TRUNCATE)` every 500 commits | **11.1×**              | 1.76 s                                      |
| App runs `wal_checkpoint(RESTART)` every 500 commits  | 1.2–1.5×               | 0.38–0.46 s; 21 of 40 checkpoints were busy |

A forced checkpoint can move WAL frames into the database file before Litestream
has shipped them. Litestream notices and takes a full snapshot, which is why the
TRUNCATE replica grew 11×. The TRUNCATE runs, and one failover run, also logged
`compaction failed … write snapshot ltx: read page … EOF / invalid argument`
from the level-9 snapshot compactor. The data was still correct here, but the
same Litestream did lose frames to an application's checkpoint in the Phase 4
dogfood: see [Verifying the replica](#verifying-the-replica-swamp-club3935). A
replicated `commits.db` now runs with auto-checkpoint off, the second regime
above.

## Knowing a commit is replicated

Litestream's control socket (`socket.enabled: true`) offers `POST /sync`. With
`{"path": <db>, "wait": true}` it turns the WAL into an LTX file, uploads it,
and returns `{status, txid, replicated_txid}`. `status` is `synced` or
`no_change`.

- Litestream's TXIDs count **LTX files**, not SQLite transactions. One LTX file
  covers every transaction committed since the last one. There is no
  per-transaction mapping, and none is needed.
- **The confirmation rule:** a commit is replicated once a `/sync` call that
  _started after the commit returned_ comes back with status `synced` or
  `no_change` and `replicated_txid >= txid`. One call confirms every commit
  before it, so a burst of commits costs one sync.
- A forced sync costs one LTX upload: 9–15 ms on local emulators, about 44 ms
  with a warm connection and 30 ms RTT, and about 165 ms on a cold per-command
  connection (see the startup table).
- A forced sync is always possible, so a writer never has to wait out the 1–2
  s passive lag.

## Shutdown and crash (Q5)

- **The shutdown sync isn't reliable. Never depend on it.** Litestream opens the
  database lazily, on its first monitor tick about 1 s after start. A SIGTERM
  before that tick exits in about 1 ms without syncing: 0 of 10 runs replicated,
  on every platform. On macOS and Linux, after the tick, the final sync ran and
  took 15–30 ms. Windows has no graceful stop at all (see below). The commits
  aren't lost, because they stay in the local WAL and the next start ships them.
  But a command that ends without a forced sync has not replicated anything.
  **Every writer forces `/sync wait` before it stops the sidecar.** Serve drain
  does the same, with its timeout taken from `--shutdown-drain-timeout`.
- **Machine loss** (kill -9 the sidecar, then restore from the bucket alone):
  every confirmed commit was present in 50 of 50 runs (file), 20 of 20 (S3) and
  10 of 10 on each CI platform. What was lost was exactly the commits since the
  last confirmation: at most 6 in a confirm-every-7 loop. A write command's
  success waits for the confirmation (Phase 4D1), so no command in that window
  was told it succeeded. The commit outbox (Phase 4F, below) does not cover
  the window: it settles an entry once its commit lands in the local copy, so
  a commit lost with the machine before its confirmation stays lost, and its
  command failed.
- **Sidecar killed, then restarted on the same local files:** it shipped
  everything, including 50 commits made while it was down. 50 of 50 runs.
- **Writer killed mid-loop** (the CLI dying): every commit the writer completed
  was replicated. 10 of 10 runs on every platform.
- **Orphaned sidecars.** On macOS and Linux, a sidecar survives its parent being
  SIGKILLed. Two sidecars on one local database share Litestream's local state
  and stayed consistent in 10 of 10 local runs, but Litestream doesn't support
  this. Phase 4 adds a guard: a pidfile next to `commits.db`, where the next
  command connects to a live sidecar or kills a stale one.

## Restore, failover and fences (Q6)

Litestream 0.5 replaced 0.3's generations with LTX files in compaction levels,
laid out as `<path>/<level>/<minTXID>-<maxTXID>.ltx`. TXIDs increase along one
replica path. Its `Leaser` interface (S3 `lock.json` with conditional writes)
exists only in the library: the `replicate` command never takes a lease, so
nothing stops two writers sharing a path.

- **A shared path corrupts the replica.** A new leader restored from the old
  leader's path and replicated back to it while the old leader kept writing.
  Both reported `synced` on every call. A fresh restore then failed with
  `nonsequential page numbers in snapshot transaction` in 4 of 4 runs.
- **One path per fence isolates a zombie leader.** With the new leader writing
  to `fence-2/`, a restore of `fence-2/` matched the new leader exactly while
  the zombie kept writing to `fence-1/`. The new leader's first sync uploads a
  full snapshot, which costs the same as an initial sync (3.4 s per GB locally).
- **So:** "a generation per fence" becomes **a replica path per fence**. The
  fence id comes from the leader lease in team mode and the writer lease in solo
  mode (swamp-club#3359; `datastores.md`, **v3 writer lease**). Restore reads the current lineage from the records published beside it
  (Phase 4D2), then restores
  `_litestream/<fence>/`. Paths left by older fences are garbage-collected after
  the next fence's first confirmed sync. In solo mode the path's fence is the
  one at which the checkout's replication lineage began, so consecutive
  commands share it
  ([What changes for Phase 4D and 4E](#what-changes-for-phase-4d-and-4e)).
- A zombie's confirmations on its old path count for nothing. **A leader must
  check it still holds its fence before it acknowledges outbox entries.**
- A node that already has an older copy gets no incremental catch-up from
  `restore`. The command refuses an existing output unless it is given `-force`,
  which overwrites it with a full restore (`-if-db-not-exists` skips the restore
  instead). Only follow mode applies changes incrementally.
- Failover restore takes about 4.5 s per GB locally, plus the fixed RTT cost. A
  follower running `restore -f` keeps a warm copy 170–205 ms behind, so it can
  take over without a full download.

## Object storage (Q3)

| Datastore config                                    | Litestream replica config                                           | Notes                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3 `bucket`, `region`, `endpoint`, `forcePathStyle` | `bucket`, `region`, `endpoint`, `force-path-style`                  | 1:1                                                                                                                                                                                                                    |
| S3 credentials (AWS SDK default chain)              | AWS SDK v2 default chain: env, profile, container credentials, IMDS | Container credentials (`AWS_CONTAINER_CREDENTIALS_FULL_URI`) checked against a fake endpoint. Credentials go in the sidecar's environment, never in its YAML or argv. Litestream's `access-key-id` fields stay unused. |
| GCS `bucket`, `projectId`                           | `bucket` (`type: gs`)                                               | Object operations need no project id.                                                                                                                                                                                  |
| GCS credentials (ADC)                               | ADC (`storage.NewClient` with no options)                           | Same chain.                                                                                                                                                                                                            |
| GCS `apiEndpoint`                                   | **No equivalent.** Only `STORAGE_EMULATOR_HOST`.                    | A GCS datastore with a custom `apiEndpoint` (other than an emulator) can't be replicated as-is.                                                                                                                        |
| Filesystem datastore `path`                         | `type: file`, `path`                                                |                                                                                                                                                                                                                        |

**Layout.** The replica is datastore-scoped. It sits under the bucket prefix,
beside the datastore-scoped control plane (`datastoreControlPlaneStore()`,
swamp-club#3191; writable for the lease since swamp-club#3364), not under a
namespace:

```
<prefix>/_control/datastore-format
<prefix>/_control/writer/             solo writer lease (fence-<n>, heartbeat-<n>, released-<n>)
<prefix>/_litestream/<fence>/<level>/<min>-<max>.ltx
<prefix>/_blobs/<namespace>/sha256/<aa>/<sha256>   content chunks (storage/1)
```

Content chunks are not replicated by Litestream: datastore extensions store
them through the `storage/1` contract ("v3 chunk storage" in
`datastores.md`). `<namespace>` is the namespace slug, or `_default` for an
unnamespaced datastore.

Namespaces: this record fixes only the replica layout. One `commits.db` per
datastore gives one `_litestream/` tree. The commit store (swamp-club#3236)
keeps every namespace in that one `commits.db`, keyed by a `namespace`
column, so there are no per-namespace `_litestream/<namespace>/<fence>/`
trees. The reasons are in `datastores.md` under "v3 commit store".

## Short-lived processes (Q8)

Most CLI commands live for seconds, so the question is whether each write
command runs its own sidecar or a longer-lived process owns replication.

- **Per command** (Phase 3 measurement) costs 17–30 ms per write command on
  Linux and macOS arm64, 103 ms on macOS Intel and 110–150 ms on Windows,
  measured against local emulators.
  With 30 ms RTT the cost rises to about 197 ms, because every command opens new
  connections.
- **Long-lived** brings a forced sync down to about 44 ms at 30 ms RTT, since
  connections stay warm. But something has to own the process between commands,
  detect when it's gone, and stop it.
- **Superseded by Phase 4A:** use an idle sidecar. This record first chose a
  sidecar per command, to be revisited with real-bucket numbers. The bucket
  model showed that a per-command sidecar never compacts, so restores slow
  down with every command, and that it pays for new connections and
  credentials each time. Read-only commands still never start a sidecar.
- Serve doesn't have this problem: the leader is long-lived anyway.

## Phase 4A: replication cost on a bucket model (swamp-club#3357)

Phase 4 needed real-bucket numbers before it chose how solo mode runs
Litestream. **These figures come from a bucket model, not real buckets.** The
issue asked for real S3 and GCS buckets and said emulator numbers don't count.
Its author, the maintainer who filed it (stack72), directed this spike to use
emulators instead, on 2026-10-13 after triage in the swamp-club#3357 lifecycle,
and the approved plan (version 2) was built on that. The model is ministack (S3)
and fake-gcs-server 1.56.1 (GCS) behind a proxy that adds latency, handshakes, a
bandwidth cap and delayed credentials. MinIO could not be pulled. Request, byte
and connection counts do not depend on the emulator, so they carry over to real
buckets as they are, and the choice below rests on them. The times depend on the
model. [Real-bucket check](#real-bucket-check) lists what has to be confirmed
before Phase 4E.

**The choice for Phase 4D: an idle sidecar, not one per command.** A per-command
sidecar never runs Litestream's compaction or retention, which live inside the
sidecar process. A day of 250 per-command commands left 252 objects, and
restoring them took 18 s at 20 ms round trip and 121 s at 150 ms, against 1.1 s
and 5.7 s once compacted. It also pays new connections and credentials on every
command. An idle sidecar adds 24–283 ms to a write command. The prototype's
per-command sidecar also re-uploaded a snapshot of `commits.db` on every command
(311 MB of replica for a 4 MB database). That was a teardown-order bug, found
and fixed here: [Teardown order](#teardown-order-the-per-command-re-snapshot).
**Waiting for replication is acceptable:** with an idle sidecar, a small v3
write that waits is 2–11 times faster than the v2 push it replaces, and every
write in the table is faster (1.9–14 times).

### The model

- **Proxy** (`spike/bucket_proxy.ts`). Each request costs one round trip, and
  each new client connection costs two more, standing in for TCP and TLS 1.3. A
  bandwidth cap is shared per direction. The proxy reads a whole request body
  before it forwards it and refuses a short one, as a real bucket does. A first
  version streamed bodies on, so an upload a stopping sidecar abandoned landed
  as a truncated object and broke a restore. Those runs were thrown away.
- **Profiles.** Near S3: 20 ms round trip, 200 Mbit/s. Far S3: 150 ms, 100
  Mbit/s. Near GCS: 20 ms, 200 Mbit/s. Zero: no latency, no cap.
- **Credentials.** S3 credentials come from a fake container-credentials
  endpoint, delayed by 0 ms (static keys), 50 ms (instance or workload identity)
  or 600 ms (an SSO refresh). Every fresh client really resolves them through
  it. fake-gcs needs no auth, so GCS rows carry no credential cost. On a real
  bucket, add the ADC token fetch: a request to the metadata server on Google
  Cloud, or an OAuth token refresh over a new TLS connection for user
  credentials, once per sidecar. It is not modelled, and the real-bucket check
  measures it.
- **Prototype.** Branch `spike/3357-litestream-buckets`, cut from main at
  `34b275cb` and later rebased onto main with the fenced writer lease
  (swamp-club#3359), for the teardown-order and replica-path runs.
  `SWAMP_SPIKE_LITESTREAM=percommand` starts a sidecar when the command takes
  the v3 writer lock. At teardown it forces one `/sync {"wait": true}` after the
  closing compaction and before the lock is released, then stops the sidecar.
  `idle` reuses a sidecar found through a pidfile and its socket. The Q1–Q5 runs
  used this original teardown order; see
  [Teardown order](#teardown-order-the-per-command-re-snapshot). It runs on a
  filesystem-v3 datastore, whose chunks stay on local disk. Phase 4 uploads
  chunks through `storage/1` before the commit, so the large-output rows add a
  measured upload of the same chunk bytes through the proxy, eight at a time, in
  series before the sync.
- Litestream 0.5.17, Apple M-series, macOS. Median and p95, nearest rank. The
  first run of each series (Litestream's first snapshot) is left out of the
  medians. Machine load from other sessions was checked before each series. One
  noisy GCS series was rerun, and the noisy one is kept as `superseded-*`.

### Forced sync (Q1)

One commit, then `/sync` with `wait`; 30 runs each. **Cold** spawns a sidecar,
waits for its socket, writes, syncs and stops it, as a per-command sidecar does.
**Warm** syncs on a sidecar that is already running. Times in ms, p50 / p95.

| Profile, credentials | Cold, whole | Warm sync | Cold requests | Warm requests |
| -------------------- | ----------- | --------- | ------------- | ------------- |
| S3, zero             | 42 / 52     | 15 / 26   | 7 on 2 conns  | 1 on 0        |
| GCS, zero            | 31 / 33     | 18 / 21   | 7 on 2        | 1 on 0        |
| S3 near, static      | 144 / 150   | 36 / 37   | 7 on 2        | 1 on 0        |
| S3 near, identity    | 187 / 190   | 36 / 38   | 7 on 2        | 1 on 0        |
| S3 near, SSO         | 736 / 739   | 40 / 47   | 7 on 2        | 1 on 0        |
| S3 far, static       | 802 / 814   | 170 / 179 | 7 on 2        | 1 on 0        |
| S3 far, identity     | 858 / 872   | 174 / 250 | 7 on 2        | 1 on 0        |
| S3 far, SSO          | 1721 / 2037 | 172 / 185 | 11–12 on 3    | 1 on 0        |
| GCS near             | 167 / 182   | 50 / 57   | 7 on 2        | 1 on 0        |

- A cold sync is six LISTs and one PUT over two new connections, plus one
  credential resolution. A warm one is a single PUT on a pooled connection.
- A burst of 50 commits with one sync costs at most about 20 ms more than one
  commit at p50, so one sync per command is enough.
- The zero rows match swamp-club#3234's emulator figures (11–15 ms sync), which
  calibrates the model.
- Far S3 with SSO retried requests (11–12 instead of 7), and a stopping sidecar
  abandoned two uploads mid-body. Every series restored correctly from its
  replica afterwards.

### Whole write commands (Q2)

`model method run` writing about 1 KB, `data delete`, and a run writing about 10
MB, which is 20 MB of chunks (the log and the stdout resource). 20 runs each,
variants interleaved. "Floor" is the v3 command with no replication. v2 is
today's `@swamp/s3-datastore` or `@swamp/gcs-datastore` push, through the same
proxy and credentials. swamp-uat#496's baseline ran at zero latency, so it is
not comparable and v2 was rerun here. ms, p50.

| Profile, credentials | Op        | v3 floor | v3 per command | v3 idle sidecar | v2 push |
| -------------------- | --------- | -------- | -------------- | --------------- | ------- |
| S3 near, static      | small     | 676      | 832            | 713             | 1642    |
|                      | delete    | 501      | 645            | 542             | 1507    |
|                      | 10 MB (1) | 1630     | 1768           | 1682            | 3599    |
| S3 near, SSO         | small     | 677      | 1362           | 725             | 4654    |
|                      | delete    | 510      | 1340           | 534             | 4524    |
|                      | 10 MB     | 1625     | 2200           | 1665            | 6604    |
| S3 far, static       | small     | 546      | 1417           | 829             | 6406    |
|                      | delete    | 471      | 1329           | 657             | 5950    |
|                      | 10 MB     | 2577     | 3451           | 2774            | 10049   |
| S3 far, SSO          | small     | 663      | 2338           | 855             | 9383    |
|                      | delete    | 475      | 2319           | 658             | 8975    |
|                      | 10 MB     | 2579     | 4238           | 2764            | 13045   |
| GCS near (no auth)   | small     | 555      | 752            | 632             | 1246    |
|                      | delete    | 475      | 668            | 530             | 1092    |
|                      | 10 MB     | 1641     | 1799           | 1690            | 3129    |

(1) v3 10 MB rows include the measured chunk upload: about 0.93 s on near
profiles and 1.9 s on far S3.

- **Per-command rows use the original teardown order,** so each one also
  uploaded a snapshot of about 230 KB. With the fixed order that upload goes
  away, which saves about 10 ms at 200 Mbit/s and 20 ms at 100 Mbit/s. The
  per-command rows are otherwise unchanged by the fix.
- **The cost of waiting.** Over the floor, across the small, delete and 10 MB
  rows, an idle sidecar adds 24–52 ms on near S3, 49–77 ms on GCS and 183–283 ms
  on far S3. A per-command sidecar adds 138–830 ms near, 158–197 ms on GCS and
  858–1844 ms far, mostly new connections and credentials.
- **Against v2.** v2 makes 45–53 requests on 19–23 new connections per small
  write, and its S3 client resolves credentials five times per command. That is
  why SSO costs v2 3–4 s. Every v3 variant is faster than v2 on every row. With
  an idle sidecar a small write is 2.0–2.3 times faster near (6.4 times with
  SSO) and 7.7–11 times faster far. The wait replaces the push, and it is
  cheaper.
- **The floor varies between configurations** (546–677 ms for a small write)
  because it touches no network: the difference is machine load and run order,
  not the profile. Variants are interleaved inside each configuration, so
  compare them along a row, not down the floor column.
- p95 stayed within 10 % of p50 except where machine load hit every variant at
  once (the near SSO floor p95 is 1189 ms). Raw p95s are in the results.

### Teardown order: the per-command re-snapshot

As first built, a per-command sidecar uploaded about 248 KB for a 1 KB write,
against 18 KB on an idle sidecar. Litestream's debug log gave the reason at each
start: `wal truncated by another process`, `wal overwritten by another process`
or `wal header salt reset`.

**The cause, traced.** `spike/exp_wal_trace.ts` records the `commits.db-wal`
header at every step of a write command. Every command started with no WAL file,
and the WAL disappeared when the commit store closed. The prototype stopped the
sidecar first, so swamp held the last connection to `commits.db` when it closed
it. SQLite then checkpointed and deleted the WAL, and the next command's sidecar
could not continue from the position it had saved.

- Moving the sync after the stores close did not help either. Litestream opens
  the database lazily, about a second after it starts (see
  [Shutdown and crash](#shutdown-and-crash-q5)). A sub-second command closes its
  stores before the sidecar has opened `commits.db` at all.
- A synthetic writer that closed after a forced sync never reproduced it,
  because the sync had made the sidecar open the database first
  (`spike/probe_wal_salt.ts`).

**The fix: sync, close the stores, then stop the sidecar.** The forced sync
makes Litestream open `commits.db`. The stores then close while it still holds
the database, so swamp's close is not the last one and the WAL survives. Only
then does the sidecar stop. With that order, 8 of 8 commands logged no snapshot,
and each L0 file held only that command's change (15–19 KB). The WAL kept one
salt across commands and grew until a normal checkpoint.

**Replica growth (Q4)** over a typical day of 200 model runs and 50 deletes, one
commit each, with SQLite's default checkpointing:

| Sidecar                                   | `commits.db` | Replica at end | 330 s later         |
| ----------------------------------------- | ------------ | -------------- | ------------------- |
| Per command, original order, 250 commands | 4.0 MB       | 311 MB         | 311 MB, 250 objects |
| Per command, fixed order, 250 commands    | 4.0 MB       | 4.2 MB         | 4.2 MB, 252 objects |
| Idle, 250 commands                        | 4.0 MB       | 7.9 MB         | 5.1 MB, 11 objects  |
| Idle, heavy day of 1250 commands          | 20 MB        | 30.6 MB        | 27.3 MB, 37 objects |

- With the fixed order a per-command replica grows linearly, 16.7 KB per commit.
  It still never compacts: one L0 object per command, kept until something
  long-lived compacts them.
- **What no compaction costs.** Restoring that 252-object replica took 18.4 s on
  near S3 and 121 s on far S3, in 283 requests. A long-lived sidecar started
  later on the same database compacted it to 4 objects in about six minutes, and
  the restore then took 1.1 s and 5.7 s in 32 requests. 5 of 5 restores passed
  the integrity check on each profile, before and after. So a takeover or a
  first clone slows down with every command since the last compaction.
- On an idle sidecar growth is linear, 24.5–31.6 KB per commit, and compaction
  brings the replica to 1.3–1.4 times the database. Its first restart after an
  idle timeout uploaded a 1.2 MB snapshot of a 2 MB database
  (`exp_idle_restart.ts`); later restarts did not. That run used the original
  order, and the sidecar was the last connection when it exited, so 4D should
  check it again with the fixed order.

### Restore (Q3)

`litestream restore` to a fresh path, then `PRAGMA integrity_check` and a
row-for-row count. Every restore passed: 20 of 20 at 1 MB and 100 MB, 10 of 10
at 1 GB. p50.

| Profile  | 1 MB  | 100 MB | 1 GB  | Requests | Follow lag, 200 ms poll | Follow lag, 1 s poll |
| -------- | ----- | ------ | ----- | -------- | ----------------------- | -------------------- |
| S3 near  | 1.1 s | 6.8 s  | 59 s  | 32–41    | 66 ms (p95 276)         | 863 ms               |
| S3 far   | 5.5 s | 16.0 s | 116 s | 32–44    | 1482 ms                 | 733 ms               |
| GCS near | 0.8 s | 6.4 s  | 58 s  | 21–24    | 250 ms                  | 847 ms               |

- A small restore costs about 32 round trips one after another, so it costs 5.5
  s at 150 ms. A takeover or a first clone pays that before it can write.
- Large restores follow the bandwidth cap: 1 GB at 200 Mbit/s is 43 s of
  transfer.
- Follow lag is measured from the leader's acknowledged sync. At 150 ms a poll
  takes longer than 200 ms, so the 200 ms interval lagged more than the 1 s
  default. Pick the interval from the round trip, not below it.
- fake-gcs answers a resumable upload with a location that points straight at
  the emulator, so in the runs above GCS uploads over 16 MB (the Go client's
  chunk size) bypassed the proxy. The proxy now rewrites that location back
  through itself. A 100 MB GCS initial sync then took 9.4 s, against 10.1 s on
  near S3; the restore times above were downloads and always went through the
  proxy.

### The idle sidecar (Q5)

- **Connection reuse.** After an idle gap of 1–130 s, a warm forced sync on far
  S3 opened no new connection. It took about 170 ms after gaps of 1–15 s, 233 ms
  after 30 s, 334 ms after 60 s and about 500 ms after 100–130 s.
- **When the server drops idle connections.** With the proxy closing keep-alive
  connections idle for more than 20 s, 1 of 15 syncs after gaps of 5–60 s had to
  reconnect. Litestream's own background work (L0 retention every 15 s) keeps
  the pooled connection in use. A warm sync after a gap of 25 s or more took
  324–359 ms p50 (one reconnect: 474 ms), against 802 ms cold. How long real
  endpoints keep idle connections is still on the
  [Real-bucket check](#real-bucket-check).
- **Finding a sidecar.** The pidfile and a `GET /info` on the socket found a
  live sidecar every time. A SIGKILLed sidecar left a dead socket file, and a
  pidfile could name an unrelated live pid. In both cases the probe failed and
  the command started a new sidecar.
- **A frozen sidecar hangs the command.** SIGSTOP the sidecar: its socket still
  accepts connections, nothing answers, and the next command hung until it was
  killed at 20 s. The probe needs a deadline. After the deadline, the command
  kills the process the pidfile names, once its argv shows it is this database's
  sidecar, and starts a new one. Two sidecars must never share a replica path.
- **Two writers at once.** The v3 writer lock serialises the start, so only one
  sidecar ran. The fenced writer lease that replaced the lock (swamp-club#3359)
  serialises the start the same way. It does not keep the replica path; see
  [What changes for Phase 4D and 4E](#what-changes-for-phase-4d-and-4e).
- **Sleep and wake,** approximated with SIGSTOP and SIGCONT on the sidecar, its
  watcher and the proxy, with the pidfile aged past the timeout. The idle exit
  fired on wake, and the next command started a new sidecar and succeeded. Real
  system sleep was not run. **The idle exit can race a command.** The
  prototype's watcher exits on the pidfile's age alone, so it can stop
  Litestream during a command that has just reused it. The command touches the
  pidfile before probing, which narrows the window but does not close it. 4D
  needs an exit that cannot overlap a command: for example, each command holds a
  shared lock while it uses the sidecar, and the sidecar exits only once it can
  take that lock exclusively after the timeout.
- **The idle timeout.** Make it at least Litestream's L0 retention (5 min), so
  compaction and retention run between bursts. Keep it short enough that a stale
  sidecar does not outlive a working session. **Five minutes** is the starting
  point.

### What changes for Phase 4D and 4E

> **Built, dormant (swamp-club#3416, Phase 4D1):** every 4D item below except
> restore and takeover (D2). See
> [Phase 4D1: the idle sidecar](#phase-4d1-the-idle-sidecar-swamp-club3416).
>
> **Built, dormant (swamp-club#3482, Phase 4D2):** restore, refresh and
> takeover, and a checkout-local `commits.db` while replicating (moved here
> from 4E so D2 is testable end to end). See
> [Phase 4D2](#phase-4d2-restore-refresh-and-takeover-swamp-club3482).
>
> **Built, dormant (swamp-club#3489, Phase 4D3):** serve confirms each write
> request's commits before it answers, with concurrent requests sharing
> syncs. See
> [Phase 4D3](#phase-4d3-serve-confirms-each-write-request-swamp-club3489).
>
> **Built, dormant (swamp-club#3507):** the datastore names its own replica
> through the provider's `replicaTarget()`, ready for 4E to replace the
> internal setting. See
> [Phase 4: the replica target](#phase-4-the-replica-target-swamp-club3507).
>
> **Live (swamp-club#3534, Phase 4E):** D1, D2 and D3 run for every v3
> datastore on S3 or GCS, which replicates to its provider's own target:
> setup, the binding, the narrowed Litestream environment and the retention
> rule are in `datastores.md`, **v3 on S3 and GCS**. A filesystem v3
> datastore still replicates only behind the internal setting.


- **4D: an idle sidecar for solo mode,** behind a pidfile and a short socket
  path, with a five-minute idle timeout. A probe with a deadline. Stale-sidecar
  takeover by verified pid. Read-only commands still never start one.
- **4D: an idle exit that cannot overlap a command.** Each command holds a
  shared lock while it uses the sidecar, and the sidecar exits only once it can
  take that lock exclusively after the idle timeout.
- **4D: key the replica path by lineage, not by fence.** Under the fenced writer
  lease (swamp-club#3359) every CLI write command takes a new fence, so
  `_litestream/<fence>/` gives each command a new replica path and a full
  snapshot. So the path is keyed by the fence at which this copy's replication
  began. The lineage continues while the fence just before a command's own was
  this copy's, so no other writer took the lease in between; otherwise it
  restarts at the command's fence. The prototype records the last fence when it
  takes the lease, so a command that crashed is continued by its successor.
  Litestream takes its replica path from its config at start, so a running
  sidecar on the old path is stopped and replaced when the lineage changes.
  Prototyped on main with the lease (`spike/exp_lineage.ts`, file replica, fixed
  teardown order), over 11 commits: 6 commands, 2 by another writer, 2 more, a
  command SIGKILLed after it took the lease, and 1 more:

  | Replica path              | Paths | Files | Bytes   | Decisions                                       |
  | ------------------------- | ----- | ----- | ------- | ----------------------------------------------- |
  | per fence, per command    | 10    | 57    | 1.50 MB | a new path, with a full snapshot, every command |
  | per lineage, per command  | 2     | 18    | 0.59 MB | continue ×5, restart at fence 9, continue ×3    |
  | per lineage, idle sidecar | 2     | 24    | 0.62 MB | the same; the sidecar was replaced at fence 9   |

  The newest path restored every commit (11 of 11) with an intact database in
  each case. The crashed command's successor continued the lineage. The old path
  keeps its last state for garbage collection after the new path's first
  confirmed sync. Two effects came from the filesystem prototype, where both
  writers share one `commits.db`: the idle sidecar's old path also picked up the
  other writer's two commits before it was replaced, and the SIGKILLed command's
  sidecar kept running as an orphan. On a bucket datastore each copy has its own
  `commits.db`, and the pidfile guard covers orphans.
- **4D: close `commits.db` while the sidecar holds it.** The teardown order is
  sync, close the stores, then stop or release the sidecar. A sidecar that is
  gone, or has not opened the database yet, when swamp closes it costs a full
  snapshot on the next start. Check the idle sidecar's first restart after a
  timeout with this order.
- **4D: credentials** resolve once per sidecar. Keep the sidecar alive across
  commands so SSO and identity costs are paid once per session, not once per
  write.
- **4E: v3 on S3 and GCS** costs less than v2's push even before tuning. Large
  outputs are dominated by the chunk upload, which `storage/1` owns. Restore
  costs about 32 round trips before any download, which the takeover and
  first-clone budgets have to allow for.
- **4E: GCS.** The record's earlier finding stands: a custom `apiEndpoint` has
  no Litestream equivalent. Test GCS uploads over 16 MB against a real bucket
  too: the model covers them only since the proxy started rewriting fake-gcs's
  upload location.

**When the choice reverses.** The re-snapshot no longer counts against per
command: the fixed teardown order removes it. Per command would win only if both
of these hold:

1. Something else compacts the replica often enough, for example a sidecar that
   serve or a scheduled job runs, so a takeover never restores thousands of L0
   objects (modelled: 252 objects took 18–121 s, compacted 1.1–5.7 s).
2. A real-bucket run shows a cold forced sync under 250 ms at p95 on near S3
   with users' real credential chains (modelled: 190 ms with identity, 739 ms
   with SSO).

The idle sidecar stands even if real endpoints drop idle connections quickly:
its background requests kept the connection in use under a 20 s drop, and
credentials and compaction still favour it.

### Real-bucket check

On a test account and never on production data, still owed:

- a cold forced sync and a warm one on near S3 (static keys, an SSO profile, and
  instance or workload identity), on far S3, and on GCS with ADC;
- how long real endpoints keep an idle pooled connection, which sets how much of
  the warm figure an idle sidecar keeps;
- what ADC adds to a cold GCS sync, which the model leaves out;
- GCS uploads over 16 MB;
- the reversal figures above.

These moved to the team-mode dogfood (Phase 5): v3 on buckets is not announced
until team mode is in place (decided 2026-10-24), so solo mode closed on the
emulator dogfood below (swamp-club#3756). The per-run tables are in that issue
and in the descriptions of swamp-club#3802, #3803 and #3882.

**What was run.** One macOS host (APFS). Six throwaway repos, one per datastore
(filesystem, S3, GCS, each in format 2 and 3), populated the same way through
the CLI: 200 `command/shell`, 40 blob and 10 `@swamp/git` behaviors, 30
workflows, about 800 method runs and 150 workflow runs, data from inline records
to 17 MiB chunks, executable and 0600 outputs, dot-named and non-ASCII names.
The v3 bucket repos hold 7,250 (S3) and 5,882 (GCS) commits, uncompacted. S3 is
ministack and GCS fake-gcs-server 1.56.1 (one per proxy, its `-public-host` set
to the proxy), each behind a TCP proxy that drops every connection, or only
Litestream's. Binaries: `main` at `bc388c720`, and release `20261024.011325.0`
(`5840c80b4`, with swamp-club#3801–#3803). Timings were interleaved, with an A/A
twin within ±5%, each round started below a load of 3.5.

**Kill criteria (K2, solo).** Neither fires.

- K2a: the p95 commit bound (the `swamp.cli` span less bootstrap and the
  method, so an upper bound on the commit) is 221–255 ms on buckets and
  122–123 ms on a filesystem (release, 30 rounds). Head pruning adds 6–7 ms at
  p95 against `bc388c720`.
- K2b, judged on buckets against v2's `pushChanged`: a workflow step costs
  51–73 ms on v3 against 0.92–1.38 s on v2, 94–95% less; a one-step workflow is
  28–53% faster.
- A v3 filesystem costs more than a v2 one, which has no `pushChanged`: a write
  +26%, a one-step workflow +27%, a step 64 ms against 28 ms (`bc388c720`). It
  is a known cost, not a kill.

**Outage behaviour.** 42 random cuts per bucket kind and binary, over method
runs, workflow runs and approves in `--json` and log mode, with the bucket held
down until the command exits: no run printed success and then lost its write
(3 of 84 did before swamp-club#3759), no error was raw or uncoded (17 on
`bc388c720`), and every failure exited within 8.3 s (up to 65 s on
`bc388c720`). The outcomes, as of swamp-club#3802 and #3882, are in
[datastores.md](datastores.md#v3-on-s3-and-gcs-datastore-rework-phase-4e):

| Outcome                                          | Exit | What landed                                 |
| ------------------------------------------------ | ---- | ------------------------------------------- |
| `datastore_v3_commit_unreachable`                | 75   | nothing                                     |
| `datastore_v3_storage_unreachable`               | 75   | nothing (cut while taking the writer)       |
| `datastore_v3_catch_up_unreachable`              | 75   | nothing; the next command finishes it       |
| `datastore_v3_read_model_busy`                   | 75   | nothing                                     |
| `datastore_v3_run_partly_committed`              | 1    | a run's last checkpoint; `workflow recover` |
| `datastore_v3_commit_partly_committed`           | 1    | part of the change                          |
| `datastore_v3_commit_may_land`                   | 1    | maybe, later                                |
| `datastore_v3_replication_unconfirmed`           | 75   | the change, saved locally, not replicated   |
| refused before any work (format marker, sidecar) | 1    | nothing                                     |

Known limit: a cut of only the replica's traffic on S3 waits the closing sync's
60 s (60.8 s measured), because Litestream retries inside the sync; GCS answers
the same cut in about 1 s.

**First clone and restore.** Release against the same repos in format 2, three
rounds; the extension's auto-install (7–9 s, both formats) and the Litestream
download (once per swamp home) are paid separately:

| Cell                     | v2     | v3     | v3 / v2 |
| ------------------------ | ------ | ------ | ------- |
| S3 clone, `data list`    | 15.3 s | 29.2 s | 1.90x   |
| S3 clone, write-first    | 15.8 s | 29.8 s | 1.89x   |
| S3 restore, `data list`  | 19.0 s | 29.4 s | 1.55x   |
| S3 restore, write-first  | 19.1 s | 31.6 s | 1.66x   |
| GCS clone, `data list`   | 6.8 s  | 20.8 s | 3.06x   |
| GCS clone, write-first   | 7.1 s  | 21.8 s | 3.09x   |
| GCS restore, `data list` | 10.2 s | 21.5 s | 2.11x   |
| GCS restore, write-first | 9.9 s  | 23.2 s | 2.35x   |

swamp-club#3418's 1.5x is not met. The cost grows with the history a clone
replays: compaction kept the last 7 days and the newest 10,000 commits, so
these repos replayed all of theirs. v3's own times match swamp-club#3803's; the
ratios moved with v2's.

**The compaction policy (swamp-club#3916).** Compaction now keeps the newest
2,500 commits by count and folds at least 500 at a time; only a retention pass
keeps a time window, of a day. Measured on filesystem v3, because a bucket
replica could not be restored once Litestream had compacted it
(swamp-club#3935), on a repo populated as above (about 5,500 commits; 2,500 or
500 retained; medians of 3–5 interleaved rounds with A/A twins):

| Cell                                | Before  | After                |
| ----------------------------------- | ------- | -------------------- |
| Fresh clone, `data list`            | 22.3 s  | 20.5 s (2,500 kept)¹ |
| Restore, `data list`                | 20.7 s  | 18.8 s (2,500 kept)  |
| Checkout 200 behind                 | 2.0 s   | 1.8 s (replays)      |
| Checkout 1,000 behind               | 5.7 s   | 10.4 s if 500 kept   |
| Checkout 3,000 behind               | 14.0 s  | 14.5 s (base load)   |
| First writes after the upgrade      | 0.6 s   | 2.5 s each, for 3²   |
| Writes, reads, workflow steps       | –       | within 3% (15 rounds) |

¹ The A/A twin's median; the branch's own was 26.0 s with one sample under
load. ² With the 2 s cap; uncapped, the first write took about 6 s.

- **Where a clone's time goes.** A trace of each shows both write the same
  ~32,000 files that are live at the end of the feed, about 9 s, which no
  policy changes: #3803's net replay already skips superseded writes. What
  compaction removes is per-commit work (catalog, state, path targeting),
  about 1.3 ms a commit: 7.4 s at 5,500 commits uncompacted, against a fixed
  base load of about 4 s (staging and catalog) plus the retained tail. The
  gain is small at this size and grows with history; the clone no longer
  does.
- **Why 2,500.** A base load costs 10–14 s here, replay about 4.5 ms a commit,
  so they break even near 2,500–3,000 commits behind. With 500 kept, a
  checkout 1,000 behind took 10.4 s against 5.7 s; with 2,500 kept it
  replays, never slower than before.
- **The first fold after an upgrade.** Unbounded, the first writer folded
  4,984 commits at teardown in about 6 s. A CLI writer now stops after 2 s
  (plus the batch in flight) and the next writer goes on: three writes of
  about 2.5 s, then 0.6 s again. Serve's hourly maintenance keeps 60 s.
- **Netted base load.** A fresh checkout's base load skipped the 665 base
  files the tail replaced or removed; the tail after a compacted base touches
  few files, so the saving is small.
- **Against v2 and on buckets.** A v2 filesystem datastore has no clone step,
  so these cells have no v2 ratio. Bucket clone and restore are measured in
  the team-mode dogfood once swamp-club#3935 is fixed; on buckets the replica
  restore adds about 2 s to the same read-model work.

**Storage.** For the same work v3 stores 5–7x fewer objects than v2 (2,265–3,387
against 14,391–17,820); bytes follow each repo's mix of large blobs, so neither
format is smaller. Nothing is reclaimed the same day: an unreferenced chunk
keeps its 24 h grace (`DEFAULT_CHUNK_GRACE_MS`), so `data gc` and `datastore gc`
left the chunks in place. Locally, v3's checkout and v2's cache under the swamp
home are the same order (560–850 MB against 610–620 MB).

**Known limits.**

- macOS chunk barrier (swamp-club#3737) on a busy disk: an 18 KiB write's p95 is
  2.0 s on v3 against 0.75 s on v2 (idle disk: 0.69 s against 0.53 s).
- `datastore setup filesystem --format 3` fails with `unable to open database
  file` when the path goes through a symlinked directory.
- A checkout behind the writer that reads during a Litestream cut hangs about
  112 s, then exits 0 (measured in swamp-club#3882's verification). Since
  swamp-club#3893 its restore is watched and the read fails with
  `datastore_v3_catch_up_unreachable` within about 10 s (about 12 s since
  swamp-club#4092 spaced the listings).
- A SIGKILLed workflow's per-model lock outlives `workflow recover`, so the next
  `data gc` waits out the lock's 30 s TTL (v2 too).

**Deferred.** Lazy content (only if clones are still over target after the
compaction policy) and the full-replay crash bug (Phase 7). The long silent
waits this phase found (crash recovery after a writer is killed mid-method,
`data prune` before any output, and the 112 s read above) were addressed in
swamp-club#3893.

**Not measured.** Real S3 and GCS, and SSO, instance and workload identity.

### Phase 4D1: the idle sidecar (swamp-club#3416)

Live on S3 and GCS since Phase 4E (swamp-club#3534): a v3 datastore there
replicates to its provider's own target. On a filesystem-v3 datastore nothing
replicates unless the internal, undocumented `SWAMP_V3_REPLICA` variable
names a file or S3 replica, which only tests set, and which wins on a bucket
too; with it unset, a write command starts nothing there and creates nothing.

**What runs.** A write command's `holdV3Writer` acquires the sidecar once the
checkout's recovery has run. The sidecar is a supervisor, a detached swamp
process that `main.ts` enters before any of the CLI runs, with Litestream as its
child in the supervisor's process group. Litestream starts with
`-no-expand-env`, after `LitestreamBinaryProvider.resolve()` checks the hash.

**Where its state lives.**

- Beside `commits.db`, in `.commits.db-replication/`, only non-secret shared
  files: `supervisor.lock`, `presence.json` (the pidfile: pids, uid, hostname,
  the supervisor's process identity, lineage fence), `replace-<pid>` marks,
  `use.lock` and `lineage.json`. The directory and the pidfile are trusted
  only when this user owns them. A sidecar is this machine's by the
  supervisor's process identity (`sameKernel`: boot id and pid namespace),
  never by the hostname, which a DHCP renewal can change under a live
  sidecar (swamp-club#3801); a record without one is judged by hostname.
- In `/tmp/swamp-<uid>/<hash>/`, created 0700 and checked before every use:
  the Litestream config and the control socket. A socket another user owns is
  refused before it is connected to.
- Every path derives from the canonical (`realPath`) `commits.db`.

**Liveness is a lock, not a pid.** The supervisor holds `supervisor.lock` for
its whole life, so the kernel drops it when the supervisor dies. A command:

1. takes `use.lock` shared, so the sidecar cannot idle out while the command
   looks at it;
2. tries `supervisor.lock`. Free means no sidecar runs. The command keeps the
   probe lock while it reads the pidfile and kills a Litestream a dead
   supervisor left behind, then launches a supervisor. The supervisor retries
   the lock for a second, so the probe never makes it give up;
3. otherwise verifies the recorded supervisor's arguments (the supervisor
   marker and this database's path, read from `/proc/<pid>/cmdline` on Linux
   and `ps` on macOS) and probes `GET /info` with a deadline. It reuses a
   sidecar that answers on its lineage, and replaces one that is frozen, on
   another lineage, or marked after a definite sync failure. A replacement
   upgrades the command's own `use.lock` to exclusive, so it never kills a
   sidecar another command or serve uses, kills the verified supervisor's
   process group, and waits for `supervisor.lock` to come free. Anything it
   cannot verify, including another user's or host's sidecar, is waited for and
   then refused, never killed.

**The idle exit** comes after five minutes with no use: `use.lock`'s mtime is
the last use, and the supervisor stops Litestream only while it holds
`use.lock` exclusively. It waits 10 s for Litestream to stop before killing it,
and commands wait 20 s for the lock, so a command that arrives during a slow
stop gets the lock once the sidecar has gone.

**Confirming a command's commits.** `closeV3Datastores` compacts, makes one
`POST /sync` with `wait` per datastore, checks `replicated_txid >= txid`, then
runs `checkV3WriterLease`. Only then does it close the stores, release the
sidecar, and release the lease. A failed or timed-out sync fails the command
with `datastore_v3_replication_unconfirmed` and exit code 75: the commits are
kept in `commits.db` and replicate when this checkout writes next. If another
checkout writes to the datastore first, this copy's next refresh restores the
newer lineage over them and they are lost; the message says so, and that
restore logs a warning naming how many commits it dropped (swamp-club#3565).
That error is only for a command that committed something: one whose commit
log did not move since it first held the writer, such as one cut off while it
records its lineage, says nothing was changed instead (swamp-club#3882; see
`datastores.md`). A definite failure (an error answer, or a socket that refuses) marks the sidecar
for replacement, while a timeout leaves it running so a large first snapshot can
finish. The default deadline is 60 s.

> **Decision:** in D1 the sync runs at teardown, after the command has printed
> its result, so `--json` stdout can hold a success document while stderr holds
> the error and the exit code is 75. Phase 4E meant to move the confirmation
> before the command's output. It kept it at teardown (swamp-club#3534): a
> command renders inside its root unit of work, and a v3 root commits when it
> ends, so a check before the output would run before the command's own
> commits landed. Since swamp-club#3759 the output waits for the root's commit
> (the CLI root helpers hold stdout until it lands), so a command never prints
> success for a commit that failed; the replication check stays at teardown,
> and success followed by exit 75 is the one remaining case.
> The rethrow already finishes the teardown: the CLI's error path runs the
> auth-gate refresh and records the failure in telemetry before it exits. The
> supervisor keeps the launching command's environment, which it needs to
> find the binary; since 4E, Litestream itself runs with only what its replica
> needs (`litestreamChildEnv`, [the replica target](#phase-4-the-replica-target-swamp-club3507)).

**Lineage.** A listener on the writer lease (`onV3LeaseTaken`) records every
fence this process takes in `lineage.json`, including serve's retake and a
read-only command's recovery hold, so a crashed command and a recovering read
still continue the lineage. A failed write removes the record (one restart),
and it never costs the lease. Abandoned lineages are kept in
`previousLineages` for a later garbage collection.

**Serve** keeps its sidecar for as long as it holds the lease. A retake at a new
fence, or a 30 s probe that finds the sidecar not answering or the copy not
current, replaces it through one tracked replacement at a time, which shutdown
waits for. A replacement asked for while one runs is not dropped: it runs once
the running one settles (swamp-club#3565). The closing sync
gets what the drain left, and at least 10 s, so `--shutdown-drain-timeout 0`
still syncs. Commits between drains replicate within Litestream's 1–2 s lag,
and since Phase 4D3 a write request waits for its own confirmation before it
answers. The maintenance timer also syncs the read model's unsynced files and
clears their list (swamp-club#3337), on start and every hour. This is the one
change that is live on filesystem-v3 serve today, and it changes no file
content. A systemd-managed serve needs `KillMode=mixed` or `process`: under the
default `control-group` the detached supervisor and Litestream are signalled
with serve and race its closing sync.

**Measured** on macOS arm64 with the compiled binary and a file replica:

- **Starting a sidecar:** 1.5–1.9 s warm and 3.2 s cold before `/info`
  answers. Commands that reuse the sidecar do not pay it. A frozen sidecar
  looks like one still starting, so a command waits the whole start wait
  (15 s) before it replaces one.
- **A probe per reuse:** a command holding the sidecar already asks `/info`
  before it shares the hold again, so a sidecar that died is never handed
  out.
- **Supervisor memory:** about 370 MB resident (Litestream about 35 MB). It
  imports `main.ts`, and through it the CLI's whole module graph, which
  `serve_run_entry_scope_rules_test` requires. Accepted while the sidecar is
  dormant; slimming the supervisor's entry is a 4E question.
- **The first restart after an idle exit,** with the teardown order above,
  uploaded 2.9 KB for an 80 KB `commits.db`, not a snapshot, and every commit
  restored. A sidecar killed and restarted within a lineage uploaded less than
  half the database.

**Tests.** The integration tests (`datastore_v3_litestream_replication_test.ts`)
run a real Litestream from `SWAMP_LITESTREAM_PATH`, which `verify-build` fetches
and hash-checks. They are ignored when it is unset, and on Windows. The S3 case
runs only with `SWAMP_TEST_LITESTREAM_S3_ENDPOINT`.

### Phase 4D2: restore, refresh and takeover (swamp-club#3482)

Live on S3 and GCS since Phase 4E (swamp-club#3534). On a filesystem
datastore it stays behind the same internal `SWAMP_V3_REPLICA` setting as D1;
with it unset nothing changes there: the datastore's own `commits.db`, and
nothing written under `_control/lineage/`.

**A copy per checkout.** While replicating, each checkout keeps its own
`commits.db` under `.swamp/_datastore_v3_copies/<hash of the datastore's
canonical path>/`, with D1's `.commits.db-replication/` beside it. Chunks,
the format marker and the lease stay in the datastore. Two checkouts on one
filesystem-v3 datastore then behave like two machines on a bucket, which is
what the tests use. `v3CommitsDbPath` alone decides the file; a fitness rule
pins it.

A replicated filesystem datastore holds no `commits.db` at its root, so a
format marker a crash lost there is not recognised as a lost v3 marker
(swamp-club#3617): under a config that says format 3 the guard refuses it
as a plain format mismatch (no readable marker), under any other it reads as
format 2, and neither `doctor datastores --repair` nor a setup re-run
restores it. Restoring it is out of scope.

**The published lineage.** Each lineage's records live in the datastore's
control plane, beside the lease, at `_control/lineage/<fence>/`:

- `started.json`, created once (`putIfAbsent`) by the writer that begins the
  lineage, before its sidecar uploads: the fence, holder, replica root and
  time;
- `head-<writer fence>.json`, rewritten by that writer after each sync
  Litestream confirmed: the TXID and swamp's **high-water mark**, the commit
  store's last cursor and the commit at it. Each writer has its own key and a
  read takes the highest writer's, so a head never goes backwards: two
  processes in one checkout share and continue one lineage, and the first,
  fenced and publishing late, must not overwrite the head of the second,
  which already acknowledged more. `copy.json` likewise only moves forward.
  Every 16th writer fence prunes the heads below its own once its sync passed
  the lease check (swamp-club#3803), 16 deletes at a time, at most 64,
  so a lineage that many commands continue does not make every read list one
  head per command. It keeps the newest head below its own as well: a swamp
  before this one, which never lists a lineage again, may have listed the
  heads just before the pruning writer published. A read that finds a listed
  head above the one it reads gone lists the lineage again, up to three times,
  before it settles on a lower head or treats the lineage as headless;
- `confirmed.json`, created once, after the lineage's first head.

**The current state** is the highest lineage under the current replica root
that is started, confirmed and has a head. Records that do not parse are
ignored.

A lineage is under the current root when its recorded root matches
(`ReplicaRoot.matches`, swamp-club#3801). The root is still written in full
(`s3:<endpoint>:<bucket>:<path>`), but an S3 root matches any endpoint
spelling of its bucket and path: the endpoint is how a checkout reaches the
bucket, not which replica it is, and the records live in that bucket, so
another S3 service never sees them. Two checkouts that spell one endpoint
differently (a trailing slash, the default explicit or implicit, a proxy)
share one lineage chain. A lineage under a root that does not match is
history while a lineage of this root was started after it, and ignored. One
started above every lineage of this root, or when none was, would decide
the state: readers and writers alike are refused with
`datastore_v3_replica_root_mismatch`, naming both roots, rather than reading
an empty datastore or starting a lineage beside it.

A lineage's start also records `follows`, the current lineage the writer's
copy was made current to, and `chained`, so a lineage this swamp began with
nothing to follow is never read as an older swamp's. The lineages form a
chain: one this swamp started continues the one it follows; one a swamp
before swamp-club#3801 started (no `chained`) continues the highest
complete lineage below it under its exact root spelling, the only ones it
could restore. Collection removes a lineage below the current one unless an
older swamp's ancestor of the current lineage, under another spelling,
superseded it: that ancestor never saw it, so its commits may be nowhere
else (a fork left by older swamps, or an older swamp writing beside an
upgraded one during a rollout). Such a lineage is kept, and
`lineage/<fence>/kept.json` records it, so every later collection keeps it
too, after the chain that showed the fork is collected. A warning names
them once, for an operator to recover from and remove by hand; while they
stay, chunk collection defers, so their chunks stay too. A checkout that
only changed its endpoint spelling under an older swamp leaves the same
records and is kept the same way: it costs storage, never commits. An
older swamp still collects lineages of its own spelling below its current
one, kept or not, as it always did.

#### Recovering kept replication lineages

`swamp doctor datastores` reports kept lineages on every run (the
`v3_kept_lineages` check, and `v3KeptLineagesFinding` in `--json`): each
one's fence, replica root, holder and start time. While any remain,
`swamp datastore gc` refuses chunk collection on every run and names them.
There is no repair command; an operator resolves them by hand:

1. **Restore a kept lineage to a scratch file.** Use the Litestream swamp
   pins (`~/.swamp/litestream/<version>/litestream`) with a config naming the
   lineage's replica path, `<prefix>/_litestream/<fence>` in the bucket, and
   the bucket's `region`, `endpoint` and `force-path-style` as the datastore
   uses them:

   ```yaml
   dbs:
     - path: "/tmp/kept-<fence>.db"
       replica:
         type: s3
         bucket: "<bucket>"
         path: "<prefix>/_litestream/<fence>"
         endpoint: "<endpoint>"
   ```

   then `litestream restore -config kept.yml -o /tmp/kept-<fence>.db
   /tmp/kept-<fence>.db`.
2. **Tell whether it holds commits the current state lacks.** The checkout's
   own copy is `.swamp/_datastore_v3_copies/<key>/commits.db`, current after
   any command. Commits are named by `(namespace, partition, txn_id)` in the
   `commits` table: any row in the kept lineage's file whose triple is
   missing from the copy is a commit only that lineage holds. None missing
   means nothing is lost: go to step 4.
3. **Recover what is missing.** Each missing row's `body` is the commit's
   operations. Re-run the work that produced them in a checkout of the
   current state (rerun the method or workflow, or re-put the data), rather
   than copying rows between databases: the current lineage's sequence
   numbers and fences differ.
4. **Remove the lineage.** Delete its records under the datastore's control
   plane, `_control/lineage/<fence>/` (`started.json`, `confirmed.json`,
   every `head-*.json` and `kept.json`), then its replica path
   `<prefix>/_litestream/<fence>/`. Once no kept lineage remains, the next
   collection runs.

> **Decision: head, then confirmation, then the lease check.** A writer's
> end of command is: sync, publish the head, publish the confirmation (the
> first time), check the lease, acknowledge. A model-based property test
> found two orders that lose acknowledged commits: a writer that crashed
> between a confirmation and its head left a current lineage with no mark
> to restore to, and a head published after the lease check let a paused
> writer acknowledge a commit the next writer's restore never saw. With the
> head first, every commit a writer acknowledged is under a head that any
> later lease holder reads. The cost: a writer that then fails its lease
> check leaves a head over commits nobody acknowledged. Like the commits D1
> keeps after a failed sync, they stay restorable until a newer lineage is
> confirmed.
> The writer is told so: its command fails as fenced
> (`datastore_v3_writer_fenced`) with a message saying its changes may still
> appear, because the writer that took over may restore them, and to check
> before running the command again. Without replication the fenced message
> still says nothing more was committed. Only a lease check that found the
> lease taken over says so (swamp-club#3491): one that could not read the
> lease, an I/O error, fails as unconfirmed replication, saying the changes
> were published but the lease could not be checked.

**Behind, cheaply.** `copy.json` beside the copy records which lineage, up
to which TXID, the copy holds. Before a command's first read or write it
reads the lineage records once (one list, then at most four small gets) and
compares (`decideLocalCopy`): the copy is current when it holds the current
lineage at or past its head, or when it is the copy whose own lineage, not
yet confirmed, is the newest started. Otherwise it is **missing**, **behind**
or **foreign**, and is restored. A current copy downloads nothing.

**The restore** (`restoreV3Copy`) runs the hash-checked binary into a temp
file beside the copy, with `-txid` set to the head:

1. A TXID inside a range that compaction merged after its L0 files expired
   cannot be restored. Measured on 0.5.17: with L0 retained (the default
   is five minutes), `restore -txid` gives exactly that state, later commits
   excluded; once L0 expired, any TXID inside a merged range fails with
   `no matching backup files available`, and only boundaries restore. Then
   the latest state is restored instead.
2. The result must pass SQLite's `integrity_check` (swamp's own, not
   Litestream's `-integrity-check`, so validation does not depend on the
   sidecar's version) and have a schema this swamp reads.
3. Every commit past the high-water mark is removed
   (`SqliteCommitStore.truncateAfter`): what a zombie writer uploaded after
   its last acknowledgement never lands. Removed commits release their chunk
   references as compaction does, and later commits get higher cursors. The
   data versions they recorded are not forgotten (swamp-club#3532): the
   zombie may have shared them, so each touched partition keeps them in its
   names' high-water marks and removed versions, in a snapshot at its new
   head, and no later write gives one of those numbers to other content. A
   later truncation below that head carries them over from the snapshot it
   replaces, since no kept commit records them.
   Apart from that the store is the one that appended only the commits up
   to the mark; the truncation property test holds it to both.
4. The temp file is installed. A missing copy is hard-linked into place, never over a file a reader
   created meanwhile, which is then updated in place instead. An
   existing one is updated **in place** (`replaceContentFrom`): every table
   copied from the restored file in one write transaction, through the
   store's queue, so open connections, serve's included, keep working and see
   the change atomically. `ATTACH` would do this in one statement, but Deno
   refuses it under the compiled binary's granular permissions, so the rows
   go through a second connection.

A restore is refused when the restored file does not hold the acknowledged
commit at the mark (another history), or when the commits past the mark were
compacted and cannot be removed. That happens only when a writer kept writing
after it lost the lease, then compacted, and the head's TXID had left L0.
The error says how to recover: remove that lineage's records under
`_control/lineage/<fence>/`, so its last acknowledged state is unreachable and
the one before it is current.

Restores of one copy are serialized by `restore.lock`, and the copy's
sidecar is stopped for the restore (`LitestreamReplicator.quiesce`, which
holds `use.lock` exclusively so none starts meanwhile). A read-only command
that cannot get either within the lock timeout, or whose restore fails,
reads a copy that was restored before as it is, and warns that it shows
the checkout's last restored state; a writer fails. The exception is a
replica the storage cannot list (swamp-club#3893): Litestream retries a
dropped listing for about two minutes on S3, so while a restore runs swamp
lists the replica's lineage paths itself through the provider's
`replicaPaths()` store, after 2 s and then every 2 s, each listing bounded
by 4 s, or by `SWAMP_V3_RESTORE_PROBE_MS` milliseconds when that is set to a
positive integer (a replica whose first listing is always slower: a far
region, a slow S3-compatible store). The interval follows a failed listing
too, so two that fail on the network in a row, 2 s apart, stop the restore
within about 12 s (swamp-club#4092); a restore that fails on its own first
(GCS answers the same cut within seconds) is followed by one such listing.
A failure that is not about reaching storage is not followed by a listing
and is handled as any other restore failure: a refusal of what Litestream
downloaded (a newer schema, a lineage mismatch, a corrupt copy:
`V3RestoredDatabaseRefusedError`) or any other `UserError` (a refused
config, a refused Litestream binary). Litestream failing to download is a
`V3RestoreError` whatever stopped it, so it is still followed by one. Either way a replica found unreachable fails the
command: a reader with
`datastore_v3_catch_up_unreachable` (the next command finishes the
catch-up), a writer with `datastore_v3_storage_unreachable`. A stale read
would be silent in `--json`, which carries no warnings. One failed listing
never stops a restore, and once a listing has answered during a restore,
one that only runs past its bound does not count: a slow replica is not a
cut one. A refusal still counts. So does a reader of a
copy that was never restored (no `commits.db`, or neither `copy.json` nor
its own writer's `lineage.json`), with `datastore_v3_restore_failed`: that
copy would read as an empty datastore (swamp-club#3642). A reader in a
checkout another process is writing does not restore: that writer keeps
the copy current.

**The checkout after a restore.** When the commit at the read model's cursor
changed (a foreign lineage, or dropped commits that were never
acknowledged), the checkout is rebuilt as after an interrupted writer: the
catalog is emptied, every commit replayed, and files no commit owns removed.
It runs under the writer lease, so no writer materialises files meanwhile: a
reader that cannot take the lease only replays, and the dropped commits'
files stay until a rebuild. A cursor whose commit the copy no longer stores
counts as moved. Otherwise the read model catches up incrementally.

**Takeover.** Whether a holder may be taken over is decided by
`datastores.md`'s **Writer liveness** (swamp-club#3564): on a bucket, another
machine's holder is one this process cannot judge, so it is taken over only
after its TTL plus skew, and fenced. `holdV3Writer` takes the lease, then
makes the copy current, then raises `writer_fence` in it, then decides the
lineage:

- it continues only while its lineage was published (`started.json`) and no
  lineage was started after it (`mayContinueLineage`), the fence rule holds,
  and nothing was restored. A restore always restarts the lineage, since
  Litestream must never continue a path over a different database;
- otherwise it restarts at its fence, claims the lineage (`putIfAbsent`; a
  claim that exists refuses), and its sidecar uploads a full first snapshot
  to the new path. It never starts one below a lineage already started under
  the same root: a newer lease exists, readers follow that lineage, and this
  writer's copy may lack its commits, so the start is refused
  (swamp-club#3565).

A lineage this hold already began at its own fence is kept: in serve, the
retake and a writer's hold at the same fence both decide it, so decisions on
one copy run one at a time in the process (a lease is exclusive, so no other
process decides at that fence), and the second finds the first's record
(swamp-club#3491). A claim that already exists is accepted only when this
copy recorded that lineage and its start names the same replica root; a
start under another root at the same fence is refused. A fence that went
back to one where this copy already began a lineage (the lease's records were
recreated) is refused rather than continued: Litestream must never continue
a used path over another history, and the copy's `writer_fence` refuses
commits at that fence anyway.

The old writer's order is unchanged: sync, publish, check the lease,
acknowledge. The new writer's is lease, then restore, so every commit the
old writer acknowledged is in what the new one restores. A zombie's later
uploads go to its own old path, past its head, which no restore keeps once a
newer lineage is confirmed.

Across machines, `commits.db`'s store-wide `writer_fence` no longer fences:
each copy has its own. The lease check before every acknowledgement and the
restore truncated to the mark take its place; the model-based property test
and the zombie integration test hold them to that.

**Fences outside a writer's hold** (a read-only recovery, serve's retake)
continue the copy's lineage only under the same rule, and never claim one,
so a hold on a stale copy can never continue a lineage another writer
superseded. The next writer restarts.

**Serve** publishes a head whenever its last commit moved (one sync and
publish at a time per datastore, so an earlier head is never published over
a later one), on its 30-second
replication probe as well as at its drains and shutdown, since its commits
replicate passively. A takeover after serve dies keeps every commit up to its
last probe. Since Phase 4D3 that window holds only commits nothing
acknowledged: a write request publishes its own head before it answers. A retake after
another writer makes the copy current through the same path, restoring into
serve's open store in place, then prepares its lineage before it holds a
sidecar again. From the retake until that restore lands, the copy is not
current: serve's commits are refused as fenced (the message says this process
holds the lease again and its copy is being brought up to date), and chunks
are not collected,
so nothing lands on, or is collected from, a copy that lacks the other
writer's commits. A retake while a replacement runs makes that replacement
stale (swamp-club#3565): what it restored may predate the other writer's
latest commits, so it does not mark the copy current, start a lineage or hold
a sidecar at the fence it began with; the next replacement restores again at
the retake's fence. Its read model is still rebuilt from what it restored, since
the copy's state already names that lineage and the next refresh may restore
nothing. A replacement whose lineage start was refused leaves the copy not
current, and the probe replaces it, except while the lease is lost and no
retake replaced it: the retake asks for its own replacement.

**Garbage collection.** After a lineage's first confirmation, once the
writer's lease check passed, the lineages below it under the current replica
root are collected: their paths, then their records. Paths are always
derived from the replica setting and a fence (`replicaPathFor`), never read
from a record; a file replica's path must be a directory directly under the
root's `_litestream/`, not a symlink. The current lineage and anything started
after it are never touched. Abandoned lineages under another root are
forgotten, not deleted. On S3 and GCS the paths are removed through the
provider's `replicaPaths()` (see "Phase 4: replica paths" below), which also
removes paths below the current lineage that no lineage key names, such as a
fenced writer's late upload. A provider without it keeps the paths, and
their records stay with them. Collection is best effort and never fails a
command.

**Chunk garbage collection** (swamp-club#3491) deletes chunks no commit in
the copy names. A restore's truncation, and a fenced writer's late head on an
older lineage, can leave chunks that only another lineage's head names, which
another copy may still restore. So while replicating, `swamp datastore gc` and
serve's sweep collect only when the copy holds the current lineage at or past
its head and no other lineage under the replica root is registered (a
lineage whose start was not read, or does not parse, counts as one). Until
then the collection is deferred (`datastore_v3_chunk_collection_deferred`)
and deletes nothing. Serve's sweep says so at info once per datastore per
process, naming the lineage that blocks it, and at debug after that, so a
collection that never runs can be found. A lineage whose start record does
not parse is never removed by lineage collection; the reason names its
`_control/lineage/<fence>/` records, which have to be removed by hand. The
lineage collection after a first confirmation clears the way: on a file
replica, and on S3 and GCS through the provider's `replicaPaths()`. A bucket
provider without it keeps old lineages, so chunk collection stays deferred.

**Turning replication on** over a datastore with a shared `commits.db`
(swamp-club#3491): the first writer, under the lease and `restore.lock`, seeds
its new copy from the shared database when nothing was ever published under
any replica root and the copy has no lineage, copy record or commits. The never-confirmed
check is defence in depth: a confirmed lineage under this root is restored
first and leaves the copy with commits, but one confirmed only under another
root leaves this root with nothing current and the copy empty, and the shared
commits are then no longer the state. It then
restarts its lineage at its fence, so its first sync publishes the shared
commits as the first lineage and every other copy restores them. Nothing
writes the shared database once replication is on, so a writer that seeded
and crashed before confirming leaves the next one the same commits. A
checkout whose read model applied the shared commits catches up
incrementally; readers before the first writer still read an empty copy.

**Measured** on macOS arm64 with the pinned 0.5.17
(`scripts/bench_v3_restore.ts`, median of 5):

| Replica | Size | Check on a current copy | Full restore |
| --- | --- | --- | --- |
| file | 1.2 MB | 0.33 ms | 37 ms |
| file | 116 MB | 0.21 ms | 604 ms |
| ministack S3, local | 1.2 MB | 0.78 ms | 42 ms |
| ministack S3, local | 116 MB | 0.20 ms | 571 ms |
| ministack S3, 20 ms RTT | 1.2 MB | 0.45 ms | 306 ms |
| ministack S3, 20 ms RTT | 116 MB | 0.35 ms | 19.7 s |

The check reads the control plane on the filesystem in every row; on a
bucket it becomes one list and up to four gets, about three round trips,
measured with 4E. The 20 ms RTT restore of a small copy is about 15 round
trips, half Phase 4A's modelled 32 for a cold restore with credentials. The
116 MB figure through the proxy is bound by the proxy, which delays every
64 KB chunk (about 6 MB/s), not by Litestream; the real-bucket check in the
team-mode dogfood measures bandwidth. **The first-clone budget:** a fresh machine pays one
check and one full restore before its first command; afterwards a command
whose copy is current pays only the check. Since 4E the restore logs a line
naming the lineage before it starts and one with its time after, so the cost
is visible; the restore deadline is 30 minutes (about 4.5 s per GB).

**Tests.** `integration/datastore_v3_litestream_restore_test.ts` runs real
Litestream with a file replica, each "machine" a worker with its own module
state, host name (as the lease sees it) and checkout: a fresh restore, a
stale refresh, a current reader that restores nothing, a takeover, a zombie
stalled past its lease that commits and is resumed after the takeover, a
writer killed before its first confirmation, a lease taken on a stale copy,
serve's retake restoring into its open store, GC that leaves a planted
symlink alone, setup on a second checkout, and the opt-in S3 case.
`integration/datastore_v3_litestream_restorer_test.ts` drives the restorer's
fallback, truncation and refusals with a stand-in binary.
`published_lineage_property_test.ts` runs the protocol model-based over two
or three writers with crashes at every step, zombies, late heads and
recovery holds, checking that the restore keeps every acknowledged commit and
nothing unacknowledged but a failed writer's published head.

**Known limits.**

- A fenced writer can publish heads on its old lineage until the new
  writer's lineage is confirmed, so the new writer's next refresh can
  restore commits whose command failed, and they become durable in its
  lineage. This is the head-first trade-off above. Chunk collection waits
  while such a lineage is registered (swamp-club#3491).
- Windows stays unavailable while the pin is below 0.5.18.

## Phase 4F: the commit outbox and replication (swamp-club#3490)

The commit outbox (`datastores.md`, **v3 commit outbox**) makes a commit a
writer prepared durable on its own machine until it lands. What it means for
replication:

- **Local, never replicated.** It is a file of its own beside whichever
  `commits.db` the checkout uses (`commits-outbox.db`): the datastore's, or
  while replicating the checkout's copy. Litestream's config names only
  `commits.db`, so the outbox never reaches the bucket or another machine.
- **A restore leaves it alone.** A D2 restore replaces `commits.db`'s content
  in place or installs a new file over it; the outbox beside it keeps its
  entries, and the fence chain judges them: an entry from before another
  copy's lease is dropped, and one whose partition the restore moved on is
  dropped by the head check.
- **It settles on landing, not on confirmation.** Replication is unchanged:
  a recovered commit is replicated like any other, and a command's success
  still waits for the confirmed sync. A commit that landed locally and was
  dropped by a later restore before its confirmation is lost, as before; the
  restore warns with the number dropped (swamp-club#3565).
- **Turning replication on** drops, and reports, what the shared
  `commits.db`'s outbox still holds when a copy is first seeded from it: no
  fence is raised on the shared store once replication is on, so nothing can
  judge those entries.

## Phase 4D3: serve confirms each write request (swamp-club#3489)

Live on S3 and GCS since Phase 4E, behind the internal setting on a
filesystem datastore, like D1 and D2. With replication off, serve sets no
confirmation, and no request waits.

**The gap.** D2 restores to the published head's high-water mark. Serve
answered write requests before their commits were replicated, and published a
head only on its 30 s probe, at drains and at shutdown. So a takeover after
serve died could drop up to 30 s of writes serve had acknowledged. That breaks
the decision above: a write waits for replication before it reports success.

**The seam is the request, not the root.** Most serve handlers send their
success reply inside their root unit of work, before the root commits, so a
confirmation in the root's flush would come after the reply. Instead, dispatch
wraps each write request in `confirmRequest` (`src/serve/handlers/shared.ts`):

- While the handler runs, its replies for that request id are held. A run's
  progress events pass; its outcome event (`completed`, `cancelled`,
  `suspended`) and every event after it are held (swamp-club#3759).
- When the handler ends, serve calls `confirmV3Replicated` and then sends the
  held replies in order. It does so only if serve's commit mark moved while
  the handler ran. A wrapped request that committed nothing, such as
  `run doctor` without `--fix`, never waits on other writers' commits.
- A held reply that is already an error goes out without waiting. A request
  that ends in an error drops its held outcome events and `done`, so a client
  never sees a run finish before the error that replaces it.
- On a v3 datastore without replication (a filesystem datastore), the
  replies are held the same way (`holdRepliesUntilCommitted`) and only the
  confirmation is skipped: the root's commit can still fail
  (swamp-club#3759).

`CONFIRMED_WRITE_REQUESTS` (`src/serve/write_confirmation.ts`) names the
wrapped requests:

- every request gated for its push;
- `model.method.run`, `workflow.run` and `workflow.resume`;
- `workflow.cancel`;
- `run.doctor`.

A fitness rule pins the dispatch to that set. Over HTTP, the device-auth mint
confirms its commits, outside the sync gate, before it hands out the token.
Left out on purpose:

- reads;
- `model.validate`;
- `vault.put`, whose secrets are always local;
- `workflow.signal` and `workflow.trigger.*`, which write control-plane
  records outside the commit log.

**Runs.** On v3 a run is one root, so its steps' changes commit together when
the root ends. No per-step commit exists to confirm, and step events stream
unheld. Serve confirms where it reports a run finished:

- an inline run's `done` waits in the request's hold;
- a detached run (`workflow.run`, `model.method.run`, and resumes through
  `startDetachedResume`, auto-resumes included) confirms before its buffer's
  terminal. On v3 its buffer holds the outcome event, and what follows it,
  until the buffer finishes: followers get them with `done`, and an `error`
  drops them (swamp-club#3759).

A run with model locks used to report `done` inside its root, while it held
the locks. With replication on, it reports after the root and the
confirmation, still before the locks are released. So a slow replica keeps
the locks for up to the 10 s request deadline longer.

**Group commit.** `ReplicationGroupCommit`
(`src/domain/datastore_v3/replication_group_commit.ts`) runs one sync at a time
per datastore. It is built on `syncAndPublish`, so it also serialises with the
probe and the closing sync.

- A request is confirmed by a successful sync whose published head covers the
  high-water mark read after its commits landed.
- Requests waiting when a sync starts are covered by it. A request that
  arrives during a sync waits for the next one, unless the head that sync
  publishes covers it anyway.
- The next sync starts as soon as the current one settles, for every request
  still waiting.
- A request whose commits an earlier head already covers does not sync.
- A failed sync rejects only the requests it covered. A sync that publishes no
  head, from the bare-sync fallback or with no sidecar held (released for a
  replacement, or closed), confirms nothing.

**Failure** follows the CLI:

- an unconfirmed sync answers `datastore_v3_replication_unconfirmed`;
- a fenced lease answers `datastore_v3_writer_fenced`, with the published
  wording from D2;
- a commit that fails after the handler queued its success replaces the
  success with the error.

After any of these, the handler's later replies for the request are dropped.
The commits stay in `commits.db` and ship with the next sync. A request's sync
gets 10 s (`SERVE_REQUEST_SYNC_DEADLINE_MS`), not the CLI's minute, so a stuck
sidecar fails requests rather than holding them.

**Background writes** confirm nothing, because none acknowledges a write to a
user. The 30 s probe stays their backstop:

- bookkeeping GC, boot reconciliation and method-run settle;
- token GC and secret migration, worker GC, and shutdown interrupt;
- scheduled and webhook runs (a webhook replies `queued` before its run);
- nested-run cascades;
- worker data-plane and capability writes. These reply to a worker, whose
  step reaches a client only through the run's confirmed terminal.

The sync gate is unwired on filesystem datastores, so the confirmation never
waits inside it. If a gate is ever wired for v3, the wait must stay outside the
exclusive gate, or gated writes could not share syncs.

**Measured** with `scripts/bench_v3_serve_confirm.ts` on macOS arm64, on a warm
sidecar, over 100 requests:

| Replica                       | Commit alone (p50) | Added, one request (p50 / p95) | Added, 8 concurrent (p50 / p95) | Syncs for 96 concurrent |
| ----------------------------- | ------------------ | ------------------------------ | ------------------------------- | ----------------------- |
| File                          | 0.3 ms             | 16.7 / 20.3 ms                 | 20.9 / 40.4 ms                  | 24                      |
| Local S3 emulator (ministack) | 0.4 ms             | 11.7 / 15.3 ms                 | 14.5 / 18.2 ms                  | 24                      |

One request adds a warm forced sync, as Phase 4A measured (15–18 ms on a file
replica). Concurrent requests share about one sync per four. A far bucket adds
its round trips, which Phase 4A modelled at 24–283 ms.

**Tests.**

- Unit and property tests for the coordinator, driven by deferred promises
  with no clock.
- Unit tests for the reply hold.
- `integration/serve_v3_replication_confirm_test.ts`, with real Litestream and
  a file replica:
  - a reply goes out only once a published head covers its commit;
  - concurrent writes share syncs;
  - an unconfirmed sync fails the request, and the next sync ships the
    commit;
  - a request that commits nothing makes no sync.
- `datastore_v3_litestream_restore_test.ts`: a write confirmed before serve
  answers survives a crash and a takeover.
- `integration/serve_write_confirmation_rules_test.ts` pins the dispatch, and
  that only serve, with replication on, sets the confirmation.

## Phase 4: the replica target (swamp-club#3507)

Live since Phase 4E (swamp-club#3534): a v3 datastore on a bucket replicates
to its own bucket. Only the extension knows how its config maps to a bucket
location, so the provider says where, and core never parses a provider's
config.

**The descriptor.** A provider's optional `replicaTarget()` returns a
`V3ReplicaTarget` (`src/domain/datastore/replica_target.ts`):

- S3 or S3-compatible: `{ type: "s3", bucket, prefix, region?, endpoint?,
  forcePathStyle? }`;
- GCS: `{ type: "gcs", bucket, prefix }`.

`prefix` is the key prefix of the datastore root that `storage()` and
`datastoreControlPlaneStore()` write under: no leading or trailing slash, or
empty. Core appends `_litestream/<fence>/` (`replicaPathFor`), so a provider
never builds replica paths.

**Checked at the boundary.** `parseV3ReplicaTarget` refuses any field outside
its type's list, so a target can never carry credentials. It also refuses a
prefix with an empty, `.` or `..` segment, and an endpoint that is not an
http or https URL or that carries userinfo, a query or a fragment. The
refusal names the field, never its value. `assertReplicaTargetConformance` in
`packages/testing` applies the same rules, and one fixture list keeps the two
copies equal. It also checks that the target names the provider's bucket and
that a record and a chunk the suite writes land under `prefix`.

**Refusals.** Without `replicaTarget()` a datastore cannot host v3, and the
resolver says so. A provider whose datastore Litestream cannot reach throws
from `replicaTarget()` rather than return a target that silently replicates
somewhere else. GCS with a custom `apiEndpoint` is the known case. Extensions
cannot throw core's `UserError`, so the resolver turns whatever they throw
into one that names the datastore. Setup refuses `--format 3` on these
messages, as they are (`assertV3BucketHost`).

**Resolution.** `resolveV3ReplicaSetting`
(`src/infrastructure/datastore_v3/litestream/replica_target_resolver.ts`)
returns the internal `SWAMP_V3_REPLICA` setting when it is set, and otherwise
maps the provider's target to a `V3ReplicaSetting`. That setting now has a
`gcs` kind, rendered as Litestream's `type: gs` with its bucket. Litestream
0.5.17 refuses `type: gcs`. S3's `forcePathStyle`
turns path-style requests on or off. Unset, path style is on whenever an
endpoint is set, as before, so every existing setting renders byte for byte
the same. Addressing style is not part of `replicaRootOf`, and the `file` and
`s3` roots are unchanged, so recorded lineages continue.

**Wired (swamp-club#3534).** The v3 binding (`v3_datastore_binding.ts`) is
the resolver's one production user: a bucket datastore's replica is
`resolveV3ReplicaSetting` over its provider, and its local root is keyed by
`resolveV3ProviderReplica`, the provider's own target whatever the internal
setting says. `datastore_v3_rules_test` pins `replicaTarget()` calls to the
resolver and the resolver's production users to the binding.

**Credentials and the sidecar's environment.** Both first-party extensions
resolve credentials from the default chains, and Litestream resolves them
the same way: the AWS SDK chain (environment, shared config and SSO,
container or instance identity) and Google ADC. A provider whose credentials
come from anywhere else cannot be replicated. Since 4E, Litestream itself
runs with only what its replica needs (`litestreamChildEnv`, applied with
`clearEnv` by the supervisor, which learns the replica's kind from
`--replica-type`, and by the restorer). The swamp supervisor keeps the
launching command's environment, which it needs to resolve the binary. A
file replica keeps `HOME` and `PATH`; a bucket replica keeps:

| Replica | Inherited                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3      | `AWS_*`, `HOME` (for `~/.aws`), `PATH`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lowercase), `SSL_CERT_FILE`, `SSL_CERT_DIR`                         |
| GCS     | `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_*`, `STORAGE_EMULATOR_HOST`, `HOME`, `PATH`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (and lowercase), `SSL_CERT_FILE`, `SSL_CERT_DIR` |

The proxy variables keep a proxied network's route, and the CA bundles keep
trust in a self-hosted store with an internal CA or a corporate TLS proxy.
S3-compatible stores need them most.

A GCS replica also keeps `STORAGE_EMULATOR_HOST`: it is the only way
Litestream reaches a GCS emulator, and the GCS extension refuses an
`apiEndpoint` it does not name, so without it Litestream would replicate to
real GCS while `storage()` writes to the emulator. On Windows the variables a
child process needs to start are kept too, and names match case-insensitively.

**Checked against the pinned binary.** Configs rendered from resolved
targets, one-off and on emulators (ministack, and fake-gcs-server 1.56.1
through `STORAGE_EMULATOR_HOST`). Litestream 0.5.17 replicated a WAL database
across two write bursts and restored all 200 rows, sum included, for each of:

- S3 with an endpoint, path style by default, prefix `team/root`;
- S3 with an endpoint, `forcePathStyle: true`, empty prefix;
- S3 with `forcePathStyle: false` and a virtual-hosted endpoint, prefix `vh`;
- GCS, prefix `groot`.

Each replica landed at `<prefix>/_litestream/000000000007/`, or
`_litestream/…` for the empty prefix. The first GCS run refused `type: gcs`,
which is why it renders as `gs`.

ministack also answers path-style requests, so that run did not show which
style Litestream used. A probe recording the `Host` header did. With an
endpoint and `force-path-style` left out, Litestream uses path style, so an
explicit `forcePathStyle: false` has to be written as `force-path-style:
false`. With it, requests go to `mybucket.localhost`. Unset and `true` stay
path style (`localhost/mybucket`). Path style is forced for an IP-address
endpoint regardless. Real buckets remain the
[Real-bucket check](#real-bucket-check)'s job.

## Phase 4: replica paths (swamp-club#3531)

Wired since Phase 4E (swamp-club#3534). `storage/1` is chunk-keyed
(`<prefix>/_blobs/<namespace>/sha256/…`) and cannot list or delete
Litestream's objects under `<prefix>/_litestream/<fence>/`. Without a way to
remove them, every takeover on a bucket would leave a full snapshot behind,
and its lineage records with it, so chunk collection (swamp-club#3491) would
stay deferred forever.

**The capability.** A provider's optional `replicaPaths()` returns a
`ReplicaPathStore` (`src/domain/datastore/replica_path_store.ts`), scoped to
the replica target's `<prefix>/_litestream/`:

- `list(signal)`: the fence directories present, as names without a slash;
- `removePath(fence, signal)`: deletes every object under
  `<prefix>/_litestream/<fence>/`, paging through listings, and succeeds when
  nothing is there.

A fence is exactly the 12 digits `padFence` writes, from `000000000001`;
`removePath` refuses anything else and deletes nothing. The width constant
lives beside the port, and `writer_lease.ts` takes it from there.
`assertReplicaPathConformance` in `packages/testing` checks a store: one
fence's removal leaves a sibling fence, a directory whose name starts with
the fence, and `_blobs/` alone; `list` sees what was written; malformed fences
are refused. Its `objectsPerFence` option runs it above a backend's listing
page size. One fixture list keeps the testing package's copy of the fence
rule equal to core's.

**Collection.** `collectV3Lineages` takes the store and applies the file
replica's rules: only after the new lineage's first confirmation, once the
lease check passed; never the current lineage or a later one; paths, then
records; best effort. It then lists the fences present and removes the path
of each one below the current lineage that no key under
`_control/lineage/<fence>/` names, whatever that key is. Each path is
rebuilt with `padFence` from the parsed fence, so a name the provider listed
never reaches `removePath` as given.

**Without it.** A bucket replica keeps every old lineage's path and records,
as before, and chunk collection stays deferred while they are registered.

**Bound to the provider's root.** `resolveV3ReplicaPaths`, beside
`resolveV3ReplicaSetting`, returns the provider's store together with the
replica root of the provider's own `replicaTarget()`, or none when the
provider lacks either, its target is refused, or either call throws (logged).
`collectV3Lineages` uses the store only when that root is the replica's
root, so a replica set elsewhere, such as the internal setting tests use,
never has paths removed from the provider's bucket that its registry never
recorded.

**Wired (swamp-club#3534).** A bucket datastore's binding resolves its
replica paths, and `syncAndPublishNow` passes them to `collectV3Lineages` on
a lineage's first confirmation. `datastore_v3_rules_test` pins
`replicaPaths()` calls to the resolver.

## Verifying the replica (swamp-club#3935)

**What happened.** In the Phase 4 dogfood (swamp-club#3916, on the buckets
swamp-club#3756 populated), a v3 bucket datastore of about 6,400 commits
could not be cloned on S3 or on GCS: every restore failed SQLite's integrity
check (`Tree 2 page 17040 cell 7: 2nd reference to page 4131`), while the
writer's own `commits.db` was intact. Restores at about 2,400 and 5,600
commits had worked; at 4,400, 5,300 and 6,400 they failed.

**Where it broke.** The lineage's level-9 snapshot restored cleanly. Every
compacted file restored corrupt, even alone: L1 `1-1a` with the snapshot
removed, and L2 `1-71`. The corrupt restore differed from the writer's copy
in 18 of 24,050 pages, each a valid b-tree page holding an older version of
itself (one was still as it was at TXID 2). Writes were missing; nothing
was garbled. So Litestream never captured some WAL frames: the damage was
in its L0 files, which compaction then merged.

**Why.** litestream#1578: Litestream holds a long read transaction so no
other connection can restart the WAL past what it has read. When a sync
request on its control socket runs Litestream's database setup or one of its
checkpoints, that transaction is opened on the request's context, and Go
rolls it back when the request returns. Litestream still treats the lock as
held. An application connection's auto-checkpoint (SQLite's default, 1000
pages) can then restart the WAL before Litestream reads its newest frames,
and Litestream's restart check passes, because the restarted WAL is shorter
than where it stopped. swamp triggers this squarely: every write command
starts or reuses a sidecar and forces a sync through the control socket. The
fix, #1579, is on Litestream's main branch, merged on 2026-10-20 and in no
release yet.

`scripts/repro_v3_replica_restore.ts` reproduces it with Litestream alone,
outside swamp: a WAL database written in bursts with indexed inserts,
rewrites and deletes, a forced sync after each burst, and a restore and
check after each. With 60 rounds per run (the two release rows ran the same
seeds):

| Litestream                    | App auto-checkpoint | Runs that ended corrupt |
| ----------------------------- | ------------------- | ----------------------- |
| 0.5.17 release                | 1000 (default)      | 7 of 12                 |
| 0.5.17 release                | off                 | 0 of 12                 |
| main at `f282d0e` (has #1579) | 1000 (default)      | 0 of 17                 |

One of the 17 main runs, with Litestream stopped and restarted between
bursts, restored a database that passed the integrity check but lacked rows
the writer held. The 11 later runs of that kind, three of them on the same
seed, did not. That run's harness did not yet check the sync request's
answer, so a sync refused just after the restart would look the same; it is
unexplained. The writer's check below would not catch such a loss, since
nothing about the restore fails.

**The workaround.** Until swamp pins a Litestream with #1579, a replicated
`commits.db` turns auto-checkpoint off on every connection that commits
(`SqliteCommitStoreOptions.replicated`): only Litestream checkpoints it, and
Litestream handles its own WAL restarts. This is the "auto-checkpoint off"
regime measured in [Checkpoint regimes (Q2)](#checkpoint-regimes-q2): the
same replica size and restore time. A database that does not replicate keeps
SQLite's default. The v3 fitness rule that refuses checkpoint pragmas pins
this one site.

**The writer checks its own replica.** A reader finds a replica it cannot
restore only when it clones or refreshes, and by then nobody but the writer
can use the datastore. So the sidecar's supervisor restores its own lineage,
the way a reader does: at the TXID in `copy.json` (the writer's last
published head), falling back to the latest state when compaction merged
that TXID's files away, with the same integrity and schema checks, into a
temp file in the private directory that it then deletes. It records the
verdict in `replica-verify.json` beside `lineage.json`: the lineage, the
TXID, when, and whether it restored.

- **When.** Only when the writer has acknowledged a TXID the last verdict on
  this lineage does not cover; at most once every 10 minutes; and once more
  before the sidecar idles out, if anything was acknowledged since. The
  check runs beside the tick loop, never inside a command, so no command
  waits for it. An idle sidecar does not stop while a check runs, and a stop
  request cancels it.
- **What counts as broken.** Only a restore SQLite refuses: rows from its
  integrity check, or the check itself failing with `SQLITE_CORRUPT` or
  `SQLITE_NOTADB`, which is how a badly damaged file answers. A restore that
  could not run (the bucket unreachable, or past the check's 30-minute
  deadline, the same as a reader's restore) records nothing and is tried
  again after the interval: restarting a lineage over a network failure
  would upload a full snapshot for nothing. A SQLite error counts by its
  primary result code, so extended codes such as `SQLITE_CORRUPT_INDEX` are
  corruption too.
- **What it costs.** One full restore per check: the whole database
  downloaded from the bucket, about the size of `commits.db`, and written to
  the private directory under `/tmp/swamp-<uid>`, which on a host whose
  `/tmp` is a tmpfs holds it in memory until the check deletes it.

**Recovery is a new lineage from the writer's copy.** The copy holds every
commit the writer acknowledged, so a full snapshot of it replaces the broken
lineage without losing anything.

- A CLI write command decides its lineage in `prepareV3WriterLineage`. When
  the verdict says the lineage it would continue is broken, it restarts at
  its own fence instead, through the usual claim of `started.json`, the
  outrank and foreign-root checks. Readers follow the new lineage once it is
  confirmed, and collection then removes the broken one.
  `recordV3LeaseFence` (a read-only recovery, serve's retake) never continues
  a broken lineage either.
- Serve holds one fence until it loses the lease, and a lineage cannot
  restart at a fence the copy already began one at. So when serve's 30-second
  probe finds its lineage broken, it moves its lease to the next fence
  (`WriterLease.advance`): it creates the next fence record itself, so no
  other writer can take the lease in between, and the existing retake path
  replaces its sidecar and restarts the lineage at the new fence. A commit in
  flight under the old fence is refused as fenced, as after any retake. Serve
  moves once per broken lineage: when its copy fails its own check the
  lineage is kept, and moving again would only fence its commits. A move that
  fails is logged: when the next fence was not taken it is tried again at the
  next probe; when it was taken but `commits.db` refused it, both fences are
  released and serve's lease renewal takes a fresh one, as after a lost lease,
  and the retake restarts the lineage.
- Before restarting, the writer runs SQLite's quick check on its own copy. A
  copy that fails it is not snapshotted into a new lineage, which would only
  replace one broken replica with another: the lineage is kept and the
  failure logged.
- A sidecar on the new lineage starts Litestream without its local state.
  Litestream 0.5 keeps one local position per database, not per replica, so
  a sidecar on a new lineage would otherwise resume the old lineage's
  position against an empty replica path, and fail its first sync once that
  lineage's early L0 files had expired: the first restart on the dogfood
  bucket did. `litestream-state.json` beside `lineage.json` records which
  lineage the local state belongs to, written at every sidecar start, so
  state a sidecar left on the same lineage (one that died before its first
  head was published) is kept. A copy from before the record goes by the
  lineage of its last published head.

**Doctor.** `swamp doctor datastores` reports the `v3_replica_restorable`
check (`v3ReplicaRestorableFinding` in `--json`) on a replicating checkout:
it passes when the last check of the current lineage restored it, or none has
run yet, and fails when the lineage was found broken, saying whether this
copy is intact (the next write, or a running serve, starts a new lineage) or
damaged too. It reads only the checkout's own files and downloads nothing.

**The window.** Between the write that breaks a lineage and its restart,
readers' clones and refreshes still fail: up to the check interval after the
writer stops writing, plus the time until the next write (or serve's next
probe). A reader's own failed restore could tell the writer sooner, but
readers cannot write to the writer's copy; that is left for team mode.

## Upgrades

The pinned version belongs to the swamp release that pins it. Each version
caches in its own directory, so two swamp versions on one machine don't fight
over the binary. Litestream's local state (`.commits.db-litestream/`) and the
replica's LTX format belong to that version too. Upstream has changed the
replica format once (0.3 generations to 0.5 LTX), and 0.5 ships a reader for 0.3
positions (`v3.go`). Even so, a version bump that changes on-disk or replica
format needs the same probe suite plus a restore of a replica written by the
previous pinned version.

## Windows and macOS (Q7)

**macOS** (arm64 locally, Intel on `macos-15-intel`): every probe passed. Points
for Phase 4:

- Unix socket paths are capped at about 104 bytes. A socket under a deep
  `~/.swamp/` or repo path fails to bind (`bind: invalid argument`). Use a short
  path, for example under `$TMPDIR/swamp-<hash>.sock`.
- The first run of a newly extracted binary takes 240–380 ms (once per version).

**Linux** (amd64, arm64 on CI): every probe passed.

**Windows** (amd64 `windows-latest`, arm64 `windows-11-arm`):

- **Litestream 0.5.16 and 0.5.17 can't replicate on Windows.** Directory fsync
  fails with `Access is denied`: the first two LTX files land, then every sync
  fails, and restore fails the same way (litestream#1542). The fix (#1548) is
  merged on main but not released. **The pinned version must be 0.5.18 or later
  on Windows.**
- **Deno 2.9.7 has no AF_UNIX client on Windows**
  (`op_net_connect_unix not supported on non-unix platforms`). Litestream's
  socket itself works there (curl reaches it). swamp uses
  `litestream sync -socket <path> -wait -json <db>` as the client on Windows. On
  macOS that costs 24 ms per call against 14 ms for a direct socket call.
  Windows figures are in the table below.
- There is no SIGTERM. Deno's `kill` is `TerminateProcess`, and Litestream on
  Windows only handles `os.Interrupt`. Every stop is a hard kill, which the
  crash results show is safe given the forced sync before stopping.

Two Windows builds were tested: v0.5.15, the last release before the regression,
and a build of main at the #1548 merge commit (`93ba3cd7`, reported as
`v0.5.18-0.20261008011357`). Times are p50.

|                                               | amd64 0.5.15                | amd64 `93ba3cd7`    | arm64 0.5.15                | arm64 `93ba3cd7`    |
| --------------------------------------------- | --------------------------- | ------------------- | --------------------------- | ------------------- |
| Ready (ms)                                    | 94.9                        | 82.1                | 61.7                        | 51.5                |
| Forced sync, per command (ms)                 | 50.1                        | 47.6                | 55.0                        | 51.0                |
| Whole command (ms)                            | 152.6                       | 138.2               | 126.3                       | 112.1               |
| Long-lived forced sync (ms)                   | 44.4                        | 43.2                | 48.6                        | 44.8                |
| `litestream sync -wait` subprocess (ms)       | 49.3                        | 48.2                | 49.1                        | 52.3                |
| Crash: machine loss / restart / writer killed | 10/10, 10/10, 10/10         | 10/10, 10/10, 10/10 | 10/10, 10/10, 10/10         | 10/10, 10/10, 10/10 |
| Restore 100 MB (ms)                           | —                           | 2004                | —                           | 2182                |
| Follow mode (`restore -f`)                    | **never caught up (>30 s)** | p50 169 ms behind   | **never caught up (>30 s)** | p50 185 ms behind   |

The remaining checks passed on every Windows build:

- forced sync over the socket, and restore;
- the Q2 checkpoint regimes, which behave as they do elsewhere;
- a path with spaces;
- the restart after a hard kill, which ships everything.

Windows refuses to delete `commits.db` while the sidecar holds it open
(`removeDbWhileSidecarHoldsIt: refused`). Any swamp operation that replaces or
resets `commits.db` must stop the sidecar first. The orphan probe reported that
the sidecar did not survive its parent being killed, but that probe signals the
child with `Deno.kill(pid, "SIGTERM")`, so on Windows the result is
**undetermined**. Phase 4's pidfile guard covers both outcomes.

**Verdict: Windows is supported from Litestream 0.5.18 on** (the first release
with #1548). That version doesn't exist yet: as of 2026-10-11 the latest release
is v0.5.17 (2026-08-31). Phase 4 must not pin a build from main. If 0.5.18 is
still unreleased when Phase 4 ships, the fallback below applies. Use the
`litestream sync` subprocess client there. A write command costs about 110–150
ms locally, against 17–30 ms on Linux and macOS arm64. Follow mode on Windows
also needs the fixed build.

**Fallback, if Windows replication can't be shipped:** solo mode on Windows
stays on the v2 datastore, with a warning when v3 is requested. Team mode
doesn't depend on Windows clients, because the serve leader runs on Linux or
macOS.

## Risks

- **Upstream dependency.** swamp would pin a binary whose Windows support
  regressed in a minor release (0.5.16). Pin exactly, and run a probe suite like
  this one in CI on every bump, on all five release targets.
- **A replica the writer cannot see is broken** (swamp-club#3935).
  Litestream 0.5.17 loses its read lock after a sync request, and an
  application checkpoint then drops frames from the replica
  (litestream#1578). swamp turns auto-checkpoint off on a replicated copy,
  and its sidecar checks that its lineage restores. Bump the pin to the first
  release with litestream#1579, and keep the check: it is what notices the
  next such bug before readers do. The `compaction failed … read page … EOF`
  log lines under forced checkpoints match litestream#1545 (fixed on main by
  #1547, also unreleased); swamp never forces one.
- **The sidecar sees bucket credentials and every commit.** Today's embedded
  Deno extraction checks only a version marker. It writes atomically (temp +
  rename, `0o755`) and runs a `--version` health check, but nothing verifies the
  extracted bytes, and a file replaced under `~/.swamp/deno/` would be run. The
  Litestream provider hashes the binary against the pin on every resolve
  (swamp-club#3358). Between that hash and the sidecar's start a same-user
  process could still swap the file; the sidecar issue decides whether to
  close that window.
- **Size.** Downloading keeps release binaries unchanged; embedding would
  have added 10–12 % to each.
- **Real-bucket latency** is modelled, not measured: Phase 4A ran on emulators
  behind a latency, handshake, bandwidth and credential model, and the Phase 4
  dogfood on emulators too. The [Real-bucket check](#real-bucket-check) moved
  to the team-mode dogfood (Phase 5).
- **Teardown order** (Phase 4A). If swamp closes `commits.db` after its
  sidecar has stopped, or before the sidecar has opened it, the next sidecar
  uploads a full snapshot. Sync, close the stores, then stop the sidecar.
- **GCS `apiEndpoint`** has no Litestream equivalent.

## Changes to the Phase 4, 5 and 7 plans

- **Phase 4 entry criterion.** Met on a bucket model by Phase 4A, which chose
  an idle sidecar. The [Real-bucket check](#real-bucket-check) moved to the
  team-mode dogfood (Phase 5); solo mode closed on the emulator dogfood.
- **Phase 4 (embedded datastore service):**
  - an idle sidecar: a write command reuses or starts it, forces `/sync wait`
    before it exits, and the sidecar exits after a five-minute idle timeout
    that cannot overlap a command;
  - a pidfile and a short socket path; a probe with a deadline, and takeover
    of a frozen or stale sidecar by verified pid;
  - a replica path keyed by the checkout's replication lineage, not by each
    command's fence;
  - teardown order: sync, close the stores, then stop or release the sidecar
    (Phase 4A);
  - SHA-256 check on download and on every start (built: swamp-club#3358);
  - `commits.db` keeps SQLite's default checkpointing and never forces one;
  - the confirmation rule above;
  - `litestream sync` as the client on Windows, and Windows gated on Litestream
    0.5.18 or later. Never pin a build from main. If 0.5.18 isn't released when
    Phase 4 ships, Windows solo stays on v2, with a warning when v3 is
    requested.
  - The v3 opt-in refuses v3 for a GCS datastore with a custom `apiEndpoint`,
    until that gap is closed.
  - Read-only commands don't start a sidecar.
  - restore, refresh and takeover from the published lineage, a
    checkout-local `commits.db` while replicating, and garbage collection of
    replaced lineages on a file replica (swamp-club#3482);
  - garbage collection of replaced lineage paths on S3 and GCS through the
    provider's `replicaPaths()` (swamp-club#3531), which 4E passes to lineage
    collection (swamp-club#3534);
  - the lineage records live with the lease in the bucket's datastore-wide
    control plane (swamp-club#3364, wired by swamp-club#3534).
- **Phase 5 (serve leader):**
  - a replica path per fence, not a generation;
  - the leader checks its fence before acknowledging outbox entries;
  - failover is restore and then a full first snapshot to the new fence path;
  - followers can run `restore -f` for a warm standby;
  - the serve leader keeps one long-lived sidecar.
- **Phase 7 (default flip):** if Windows solo is still on v2, the flip to v3 by
  default can't be universal. It has to leave Windows solo on v2.

## Reproducing

Phase 4A's scripts and raw results are on branch
`spike/3357-litestream-buckets` (`a751f727`), which will never be merged.
`spike/README.md` there lists each script, and the JSON lines are in
`spike/results/3357/`:

```sh
# On that branch: LITESTREAM_BIN as below, ministack on :47357 and fake-gcs on
# :47358 with bucket lsbucket, and SWAMP_BIN=<repo>/swamp from deno run compile.
cd spike
deno run -A exp_bucket_sync.ts s3-far sso 30                  # Q1 <profile> <creds> <runs>
deno run -A exp_command.ts s3-near static 20                  # Q2
deno run -A exp_restore.ts s3-near static 1,100,1000 20 10    # Q3
GROWTH_MODE=idle deno run -A exp_growth.ts typical-idle 200 50 # Q4
deno run -A exp_idle.ts gaps s3-far 1,5,15,30,60,100,130 3    # Q5
deno run -A exp_idle.ts faults s3-near
deno run -A exp_idle_restart.ts 100 3
IDLE_DROP_MS=20000 deno run -A exp_idle.ts gaps s3-far 5,15,25,40,60 3
deno run -A exp_wal_trace.ts default 5             # teardown order, as first built
deno run -A exp_wal_trace.ts sync-close-stop 8     # the fixed order
GROWTH_MODE=percommand GROWTH_ORDER=sync-close-stop \
  deno run -A exp_growth.ts typical-percommand-sync-close-stop 200 50
deno run -A exp_restore_objects.ts <growth-run>/ds/commits.db <replica-path> 5
deno run -A exp_lineage.ts                          # replica path per fence or lineage
```

The Phase 3 prototype is on branch `spike/3234-litestream` and will never be
merged. On that branch, the Phase 3 `spike/README.md` maps each script to a
question, and `spike/results/` holds the raw JSON lines quoted in the Phase 3
sections. CI results come from the `Spike 3234 Litestream` workflow on that
branch (run ids below).

```sh
# Litestream release used for darwin/linux figures (checksums verified):
gh release download v0.5.17 --repo benbjohnson/litestream -p checksums.txt \
  -p 'litestream-0.5.17-darwin-arm64.tar.gz'
export LITESTREAM_BIN=$PWD/litestream
# Emulators and RTT proxies:
docker run -d -p 45934:4566 ministackorg/ministack:latest
docker run -d -p 45935:4443 fsouza/fake-gcs-server:1.56.1 \
  -scheme http -port 4443 -public-host localhost:45935
curl -X PUT localhost:45934/lsbucket
curl -X POST 'localhost:45935/storage/v1/b?project=test' -d '{"name":"lsbucket"}'
deno run -A spike/rtt_proxy.ts 45937 http://localhost:45934 30 2 &
deno run -A spike/rtt_proxy.ts 45938 http://localhost:45935 30 2 &
# Q2  checkpoint regimes
for r in passive-default auto-off app-truncate app-restart; do
  deno run -A spike/exp_compat.ts $r 20000; done
# Q4/Q5/Q8  per-command, forced sync, lag, shutdown-only
for t in file s3:45934 s3:45937 gs:45935 gs:45938; do
  deno run -A spike/exp_latency.ts $t 20; done
# Q5  crash
deno run -A spike/exp_crash.ts 50 file; deno run -A spike/exp_crash.ts 20 s3:45934
deno run -A spike/exp_double.ts 10
# Q6  restore, follow, fences, zombie
bash spike/run_failover.sh; deno run -A spike/exp_zombie.ts 5
# Q1  option b (Go c-shared via Deno.dlopen)
(cd spike/golib && CGO_ENABLED=1 go build -buildmode=c-shared -trimpath \
  -ldflags '-s -w' -o liblitestream.dylib .) && deno run -A spike/ffi_probe.ts
# Q7  platform probe (CI runs spike/ci_run.sh on all five targets)
deno run -A spike/platform_probe.ts
```

CI runs on `spike/3234-litestream`:

- `38096585990`: Linux and macOS Intel at 0.5.17. Windows failed in the harness,
  which passed a Git-bash path for the binary.
- `38097146244`: Windows diagnostics at 0.5.17. This run shows #1542 and the
  missing AF_UNIX client in Deno.
- `38097549910`: all seven targets. Windows ran 0.5.15 and `93ba3cd7`; the rest
  ran 0.5.17.
