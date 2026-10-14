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
   the outbox learns that a commit has reached the bucket (see
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
(14 ms) than on Linux (2–4 ms), because SQLite and Litestream use `F_FULLFSYNC`
there.

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
from the level-9 snapshot compactor. The data was still correct, but this is an
open risk.

## Knowing a commit is replicated

Litestream's control socket (`socket.enabled: true`) offers `POST /sync`. With
`{"path": <db>, "wait": true}` it turns the WAL into an LTX file, uploads it,
and returns `{status, txid, replicated_txid}`. `status` is `synced` or
`no_change`.

- Litestream's TXIDs count **LTX files**, not SQLite transactions. One LTX file
  covers every transaction committed since the last one. There is no
  per-transaction mapping, and none is needed.
- **The rule for the outbox:** a commit is replicated once a `/sync` call that
  _started after the commit returned_ comes back with status `synced` or
  `no_change` and `replicated_txid >= txid`. One call confirms every commit
  before it, so a burst of commits costs one sync.
- A forced sync costs one LTX upload: 9–15 ms on local emulators, about 44 ms
  with a warm connection and 30 ms RTT, and about 165 ms on a cold per-command
  connection (see the startup table).
- A forced sync is always possible, so the outbox never has to wait out the 1–2
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
  last confirmation: at most 6 in a confirm-every-7 loop. The outbox has to
  cover that window, and with this rule it does.
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
  mode (swamp-club#3359; `datastores.md`, **v3 writer lease**). Restore reads the current fence from that record, then restores
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

Before Phase 4E ships, on a test account and never on production data:

- a cold forced sync and a warm one on near S3 (static keys, an SSO profile, and
  instance or workload identity), on far S3, and on GCS with ADC;
- how long real endpoints keep an idle pooled connection, which sets how much of
  the warm figure an idle sidecar keeps;
- what ADC adds to a cold GCS sync, which the model leaves out;
- GCS uploads over 16 MB;
- the reversal figures above.

### Phase 4D1: the idle sidecar (swamp-club#3416)

Built and dormant. Nothing replicates unless the internal, undocumented
`SWAMP_V3_REPLICA` variable names a file or S3 replica, which only tests set;
Phase 4E replaces it with the datastore's own bucket. On a filesystem-v3
datastore with it unset, a write command starts nothing and creates nothing.

**What runs.** A write command's `holdV3Writer` acquires the sidecar once the
checkout's recovery has run. The sidecar is a supervisor, a detached swamp
process that `main.ts` enters before any of the CLI runs, with Litestream as its
child in the supervisor's process group. Litestream starts with
`-no-expand-env`, after `LitestreamBinaryProvider.resolve()` checks the hash.

**Where its state lives.**

- Beside `commits.db`, in `.commits.db-replication/`, only non-secret shared
  files: `supervisor.lock`, `presence.json` (the pidfile: pids, uid, hostname,
  lineage fence), `replace-<pid>` marks, `use.lock` and `lineage.json`. The
  directory and the pidfile are trusted only when this user owns them.
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
kept in `commits.db`, and the next write replicates them. A definite failure (an
error answer, or a socket that refuses) marks the sidecar for replacement, while
a timeout leaves it running so a large first snapshot can finish. The default
deadline is 60 s.

> **Decision:** in D1 the sync runs at teardown, after the command has printed
> its result, so `--json` stdout can hold a success document while stderr holds
> the error and the exit code is 75. Phase 4E moves the confirmation before the
> command's output, once users can turn replication on. The rethrow also ends
> the CLI's teardown before its auth-gate refresh and telemetry; 4E finishes the
> teardown and then rethrows. The supervisor also inherits the launching
> command's whole environment for its lifetime; 4E narrows it to what
> Litestream needs (its credentials, `PATH`, `HOME`).

**Lineage.** A listener on the writer lease (`onV3LeaseTaken`) records every
fence this process takes in `lineage.json`, including serve's retake and a
read-only command's recovery hold, so a crashed command and a recovering read
still continue the lineage. A failed write removes the record (one restart),
and it never costs the lease. Abandoned lineages are kept in
`previousLineages` for a later garbage collection.

**Serve** keeps its sidecar for as long as it holds the lease. A retake at a new
fence, or a 30 s probe that finds the sidecar not answering, replaces it through
one tracked replacement at a time, which shutdown waits for. The closing sync
gets what the drain left, and at least 10 s, so `--shutdown-drain-timeout 0`
still syncs. Commits between drains replicate passively within Litestream's
1–2 s lag. The maintenance timer also syncs the read model's unsynced files and
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
- **Snapshot compaction errors** (`compaction failed … read page … EOF`)
  appeared under forced TRUNCATE checkpoints and once in a failover run. The
  data stayed correct. No matching upstream issue exists as of 2026-10-11 (the
  closest is litestream#1199, a different snapshot-on-checkpoint compaction
  failure). File one, with the `spike/` reproduction, before Phase 5.
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
  behind a latency, handshake, bandwidth and credential model. The
  [Real-bucket check](#real-bucket-check) has to run before Phase 4E.
- **Teardown order** (Phase 4A). If swamp closes `commits.db` after its
  sidecar has stopped, or before the sidecar has opened it, the next sidecar
  uploads a full snapshot. Sync, close the stores, then stop the sidecar.
- **GCS `apiEndpoint`** has no Litestream equivalent.

## Changes to the Phase 4, 5 and 7 plans

- **Phase 4 entry criterion.** Met on a bucket model by Phase 4A, which chose
  an idle sidecar. The [Real-bucket check](#real-bucket-check) runs before
  Phase 4E.
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
  - the outbox rule above;
  - `litestream sync` as the client on Windows, and Windows gated on Litestream
    0.5.18 or later. Never pin a build from main. If 0.5.18 isn't released when
    Phase 4 ships, Windows solo stays on v2, with a warning when v3 is
    requested.
  - The v3 opt-in refuses v3 for a GCS datastore with a custom `apiEndpoint`,
    until that gap is closed.
  - Read-only commands don't start a sidecar.
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
