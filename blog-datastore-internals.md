# How We Built Datastores in Swamp

Swamp is a CLI for AI-native automation. You define models of external services
— AWS resources, GitHub repos, whatever — and swamp validates them, runs methods
against them, and tracks results over time. That produces a lot of runtime data:
versioned model snapshots, workflow run logs, method outputs, audit trails,
telemetry. We needed somewhere to put all of it.

For a while, everything just went into a `.swamp/` directory inside the git
repo. That was fine when it was one person on one machine. It stopped working
when we wanted a team sharing runtime data, or needed to keep large binary
outputs out of git history, or wanted CI and a developer's laptop looking at the
same state.

So we built a datastore abstraction. Here's how it works.

## Definitions vs. Data

We split things into two buckets early on. Model definitions, workflow
definitions, and vault configs are source-of-truth files. They live in top-level
directories (`models/`, `workflows/`, `vaults/`) and get tracked in git. They
stay in your repo, always.

Everything else is runtime data — evaluated definitions, versioned data
snapshots, workflow run records, method outputs, secrets, audit logs, telemetry.
That's what the datastore manages. Keeping these separate means you can point
runtime data at a shared S3 bucket without your model definitions getting
tangled up in sync conflicts.

## Two Backends, One Interface

There are two datastore backends: filesystem and S3.

The **filesystem** backend stores runtime data at a local path. It's the default
— `swamp repo init` gives you `.swamp/` inside the repo. You can point it
elsewhere too, which is useful for shared NFS mounts or keeping runtime data off
your main disk.

The **S3** backend puts runtime data in an S3 bucket, with a local cache at
`~/.swamp/repos/{repoId}/`. Reads and writes hit the local cache; sync with S3
happens around each CLI command. The cache is disposable — blow it away, clone
the repo on a fresh machine, and the next command pulls everything back down.

Both backends sit behind the same `DatastorePathResolver` interface. The rest of
the codebase calls
`resolvePath("data", "aws/ec2-instance", "my-server", "latest.json")` and gets
back a path. It doesn't know or care which backend is active.

## Configuration

We wanted the datastore to be configurable from multiple places without it
getting confusing. The resolution order is:

1. `SWAMP_DATASTORE` environment variable (highest priority)
2. `--datastore` CLI flag
3. `datastore` field in `.swamp.yaml`
4. Default: filesystem at `{repoDir}/.swamp/`

The env var uses a `type:value` format — `filesystem:/path/to/dir` or
`s3:bucket-name/prefix`. Easy to set in CI without touching config files.

## Directories and Excludes

Not everything needs to go to the datastore. You might want model data and
outputs shared on S3 but telemetry staying local. The `directories` field in the
config controls which subdirectories belong to the datastore. Anything not
listed stays in local `.swamp/`.

There's also an `exclude` field that takes gitignore-style glob patterns. We
wrote a pattern matcher that compiles these to regexes up front so matching
stays fast. It handles `*`, `**`, `?`, character classes, and `!` negation —
same rules as `.gitignore`.

A file ends up in the datastore if its subdirectory is in the `directories` list
_and_ it doesn't hit an exclude pattern. Otherwise it stays local.

## S3 Sync

The filesystem backend is boring — it's just a different directory. S3 is where
things get interesting.

We wanted commands to feel local. Nobody should be thinking about network round
trips when they run `swamp model get`. So we use a local cache as the working
copy and sync around write commands.

When you run something that writes data (`swamp model create`,
`swamp workflow run`, etc.):

1. The command grabs a distributed lock and pulls changed files from S3 into the
   local cache.
2. It does its work against the local cache, same as any filesystem operation.
3. When it's done, it pushes changes back to S3 and drops the lock.

Read-only commands (`swamp model list`, `swamp model search`) skip locking and
syncing entirely — they just read the cache. Reads are fast and can run
alongside writes. The tradeoff is that on S3 datastores, reads can be slightly
stale. `swamp datastore sync --pull` refreshes manually if you need it.

### The Index

We don't list the S3 bucket on every sync. Instead there's a metadata index
(`.datastore-index.json`) mapping every file to its size and last-modified time.
It's a single S3 object fetched once per command, with a 60-second local cache
TTL so rapid commands don't hammer S3.

### Change Detection

No content hashing. We compare sizes and mtimes:

- **Pull**: files in the remote index that are missing locally or differ in size
  get downloaded.
- **Push**: local files that are new, or have a different size or mtime vs. the
  index, get uploaded.

This works because swamp writes files atomically (write to temp, rename into
place), which always bumps mtime. Even if a rewrite doesn't change the file
size, the mtime catches it.

### Concurrency and Offline

Pull and push operations run concurrently in batches of 10 — enough to speed up
multi-file syncs without hitting S3 rate limits.

If S3 is unreachable, sync warns and keeps going. The command runs against the
local cache as if it were a filesystem datastore. Changes get pushed next time
the connection comes back. Swamp doesn't break on a plane.

## Distributed Locking

Both backends use a distributed lock to prevent concurrent writes. This is what
makes the sync model safe for teams.

The lock stores who holds it (user@hostname, PID), when it was acquired, a TTL,
and a random nonce that acts as a fencing token. The interface is small:
`acquire()`, `release()`, `withLock()`, `inspect()`.

**S3Lock** uses conditional writes (`PutObject` with `If-None-Match: *`) for
atomic acquisition — if two processes race to create the lock object, only one
wins. A background heartbeat rewrites the lock every TTL/3 to keep it alive.

**FileLock** uses `Deno.open({ createNew: true })` for the same atomic semantics
on disk. Same heartbeat, same stale detection.

Staleness works the same way in both: if a lock's timestamp plus TTL is in the
past, it's stale. The next acquirer deletes it and retries. If your process gets
killed, a SIGINT handler tries to release the lock. If that fails too, it
expires in 30 seconds.

There's a breakglass path for stuck locks — `swamp datastore lock status` shows
who's holding it, and `swamp datastore lock release --force` deletes it. The
`--force` flag is required because this is the "I know what I'm doing" escape
hatch.

## Wrapping Up

The datastore abstraction exists to let teams share runtime data without it
stepping on the git-tracked model definitions. Filesystem for simplicity, S3 for
collaboration, and the lock-sync-lock lifecycle keeps things consistent without
making every command feel like a network call.

If you want to try the S3 backend, `swamp datastore setup s3` is the command. If
you find a bug, we want to hear about it.
