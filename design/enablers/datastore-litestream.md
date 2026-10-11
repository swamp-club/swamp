---
audience: maintainer
enables: [data]
last-verified: 2026-10-11 @ 53727e85
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

1. **Run the upstream `litestream` binary as a sidecar process that swamp
   supervises.** Pin one release. Embed the binary for each target in the
   compiled swamp binary with `deno compile --include`, the same way the
   embedded Deno runtime is shipped (`scripts/download_deno.ts`,
   `src/infrastructure/runtime/embedded_deno_runtime.ts`). Extract it to a
   per-version directory under `~/.swamp/` and verify its SHA-256 before every
   start.
2. **Talk to it through its control socket.** `POST /sync {"wait": true}` is how
   the outbox learns that a commit has reached the bucket (see
   [Knowing a commit is replicated](#knowing-a-commit-is-replicated)).
3. **One sidecar per writer process.** In solo mode a write command starts one,
   forces a sync before it exits, and stops it. This is the starting point; see
   [Short-lived processes](#short-lived-processes-q8). In team mode the serve
   leader keeps one running for as long as it holds the lease.
4. **`commits.db` keeps SQLite's default checkpointing and never forces a
   checkpoint.** Do not copy `catalog_store.ts`'s `wal_checkpoint(TRUNCATE)`
   pattern.
5. **One replica path per writer fence.** `<prefix>/_litestream/<fence>/`.
   Litestream 0.5 has no generations, and a second writer on the same path
   corrupts the replica.
6. **Windows: a supported target, gated on an upstream fix.** Litestream 0.5.16
   and 0.5.17 cannot replicate on Windows (litestream#1542, fixed on main by
   #1548, not yet released). Deno has no AF_UNIX client on Windows, so swamp
   reaches the socket there through `litestream sync`. See
   [Windows and macOS](#windows-and-macos-q7).

## Why a sidecar

Four options were prototyped or assessed. All measurements are in
[Measurements](#measurements).

| Option                                                                                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sidecar binary** (chosen)                                                                          | Upstream builds it for every target swamp ships. It runs in its own process, so a Litestream crash can't take swamp down, and it uses its own copy of SQLite in its own process. It adds 36–40 MB per target. Startup to a ready socket takes 13–19 ms on Linux and Apple silicon.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Go library, c-shared, via `Deno.dlopen`**                                                          | It works: dlopen took 4 ms, a sync 13 ms, and Deno's signal handling still worked. Rejected for three reasons. It loads a **second copy of SQLite into swamp's process**: Litestream uses `modernc.org/sqlite`, and `node:sqlite` bundles its own. Two copies on one file share POSIX advisory locks but not SQLite's bookkeeping, and closing a file in one silently drops the other's locks. That is a known way to corrupt a database ([sqlite.org/howtocorrupt §2.2.1](https://www.sqlite.org/howtocorrupt.html#_multiple_copies_of_sqlite_linked_into_the_same_application)). A Go panic would also kill swamp. And swamp would have to own a cgo cross-build for each of its five targets. `dlopen` needs a real file anyway, so it still has to be extracted like a sidecar. It saves only about 8 MB (29.5 MB stripped dylib against 37.5 MB). |
| **TypeScript reimplementation of WAL shipping**                                                      | Rejected. Litestream's core is about 7.4k lines of Go, plus 1.9k for the LTX format and 2.6k for the S3, GCS and file clients. The hard parts are correctness under concurrent checkpoints, WAL salt changes and snapshot boundaries, and the code cites several production bugs it has fixed there. `node:sqlite` has no WAL hook, so a reimplementation would read the `-wal` file behind SQLite's back. Revisit only if the sidecar can't ship.                                                                                                                                                                                                                                                                                                                                                                                                     |
| **LiteFS**                                                                                           | Rejected on paper. It is a FUSE filesystem, so it is Linux-only and needs mount privileges. swamp ships to macOS and Windows and runs unprivileged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **SQLite session extension** (`createSession` / `applyChangeset`, available in Deno's `node:sqlite`) | Not chosen. Changesets are logical diffs, so swamp would have to design its own log format, ordering, snapshots and restore, which amounts to writing a replicator. It stays as the fallback if Windows can't be supported (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Licensing: Litestream is Apache-2.0. A separate program shipped beside an AGPLv3
one is an aggregate. Ship its `LICENSE` with the release notes, and keep the
upstream SHA-256 in the build script.

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
  fence id comes from the leader lease in team mode and the writer lock in solo
  mode. Restore reads the current fence from that record, then restores
  `_litestream/<fence>/`. Paths left by older fences are garbage-collected after
  the next fence's first confirmed sync.
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
swamp-club#3191), not under a namespace:

```
<prefix>/_control/datastore-format
<prefix>/_control/writer              solo writer lock (carries the fence)
<prefix>/_litestream/<fence>/<level>/<min>-<max>.ltx
```

Namespaces: this record fixes only the replica layout. One `commits.db` per
datastore gives one `_litestream/` tree. Whether namespaces get their own
`commits.db`, and so their own `_litestream/<namespace>/<fence>/` trees, is the
commit-store issue's call: it is a schema question.

## Short-lived processes (Q8)

Most CLI commands live for seconds, so the question is whether each write
command runs its own sidecar or a longer-lived process owns replication.

- **Per command** costs 17–30 ms per write command on Linux and macOS arm64, 103
  ms on macOS Intel and 110–150 ms on Windows, measured against local emulators.
  With 30 ms RTT the cost rises to about 197 ms, because every command opens new
  connections.
- **Long-lived** brings a forced sync down to about 44 ms at 30 ms RTT, since
  connections stay warm. But something has to own the process between commands,
  detect when it's gone, and stop it.
- **Start per command.** It needs no daemon, and the crash results show it is
  safe. Read-only commands never start a sidecar. Revisit with real-bucket
  numbers. If the gap is near what the RTT proxy shows (about 150 ms per write
  command), add a sidecar that stays alive for a short idle period behind the
  same pidfile and socket. Commands would reuse it, and it would exit after an
  idle timeout.
- Serve doesn't have this problem: the leader is long-lived anyway.

## Upgrades

The pinned version belongs to the swamp release that embeds it. Each version
extracts to its own directory, so two swamp versions on one machine don't fight
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
with #1548). Use the `litestream sync` subprocess client there. A write command
costs about 110–150 ms locally, against 17–30 ms on Linux and macOS arm64.
Follow mode on Windows also needs the fixed build.

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
  data stayed correct. Track it upstream before Phase 5.
- **The sidecar sees bucket credentials and every commit.** Today's embedded
  Deno extraction checks only a version marker. It writes atomically (temp +
  rename, `0o755`) and runs a `--version` health check, but nothing verifies the
  extracted bytes, and a file replaced under `~/.swamp/deno/` would be run. The
  Litestream helper must verify its SHA-256 against the value embedded at build
  time before every start. That costs 14 ms on 37 MB.
- **Size.** +10–12 % per release binary.
- **Real-bucket latency** is unmeasured. The emulator-plus-RTT figures put a
  per-command forced sync at about 165 ms against a long-lived 44 ms. Measure
  against real S3 and GCS before choosing per-command or long-lived for solo
  mode.
- **GCS `apiEndpoint`** has no Litestream equivalent.

## Changes to the Phase 4 and Phase 5 plan

- **Phase 4 (embedded datastore service):**
  - sidecar lifecycle per write command: start, forced `/sync wait`, stop;
  - pidfile guard against orphans, and a short socket path;
  - SHA-256 check on extract and on every start;
  - `commits.db` keeps SQLite's default checkpointing and never forces one;
  - the outbox rule above;
  - `litestream sync` as the client on Windows, and Windows gated on Litestream
    0.5.18 or later.
  - Read-only commands don't start a sidecar.
- **Phase 5 (serve leader):**
  - a replica path per fence, not a generation;
  - the leader checks its fence before acknowledging outbox entries;
  - failover is restore and then a full first snapshot to the new fence path;
  - followers can run `restore -f` for a warm standby;
  - the serve leader keeps one long-lived sidecar.

## Reproducing

The prototype is on branch `spike/3234-litestream` and will never be merged.
`spike/README.md` maps each script to a question, and `spike/results/` holds the
raw JSON lines quoted above. CI results come from the `Spike 3234 Litestream`
workflow on that branch (run ids below).

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
