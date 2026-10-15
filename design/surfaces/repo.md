---
audience: maintainer, operator
last-verified: 2026-09-07 @ 58652907
---

# swamp repo

A swamp repo holds all the behaviors and code for automating tasks with swamp.

Initializing a repo creates the needed directories and copies in the swamp-\*
skills. Upgrading a repo moves the skills, and anything else that needs it, from
one version to the next.

The repo should have a `.swamp.yaml` file at its root recording the swamp
version it was initialized or upgraded with.

Init should write instructions that say the repository is for building
automation with swamp and when to use the linked skills. The agent should try to
use swamp for most tasks.

For Claude Code those instructions go in `CLAUDE.md`, except where a `CLAUDE.md`
would hide the repo's own `AGENTS.md`. Claude Code reads `AGENTS.md` only when
no `CLAUDE.md` exists, so the claude tool picks its target from the repo, taking
the first rule that matches:

1. `.claude/rules/swamp.md` already exists, or `CLAUDE.md` is a symlink (Claude
   Code's documented `CLAUDE.md -> AGENTS.md` setup): write
   `.claude/rules/swamp.md`. Swamp never writes through a symlinked
   `CLAUDE.md`.
2. `CLAUDE.md` already holds swamp's managed section: keep it there. When the
   file holds nothing else and `AGENTS.md` has the repo's own content, add an
   `@AGENTS.md` import inside the managed section.
3. `AGENTS.md` has the repo's own content and there is no `CLAUDE.md`: write
   `.claude/rules/swamp.md`. Claude Code loads rules files alongside
   `AGENTS.md`.
4. Otherwise: write `CLAUDE.md`.

The repo's own content means anything outside swamp's managed section. When
another enrolled tool (codex, opencode, ...) also keeps swamp's section in
`AGENTS.md`, Claude Code reads swamp's instructions twice, once from its own
target and once from `AGENTS.md`. The copies are identical, so this is accepted
rather than deduplicated. Swamp
never writes its Claude instructions into `AGENTS.md` itself, because Claude
Code before 2.1.277 (and some sessions before 2.1.281) reads only `CLAUDE.md`
files and rules, and would lose swamp's rules. A repo whose `.gitignore`
covers `.claude/` keeps the rules file out of version control, so teammates get
it from their own `swamp repo upgrade`, as they already do the skills.

## Multi-tool Repos

A repo can be enrolled for several AI agent tools at once (Amp, Claude Code,
Cursor, OpenCode, Codex, Copilot, Kiro). The marker file stores the enrolled
list as `tools: AiTool[]`. Each tool's scaffolding (skills directory,
instructions file, settings/hooks) is written separately, since the paths do
not conflict.

- `swamp repo init --tool <X> [--tool <Y>...]` sets the enrolled list.
- `swamp repo upgrade --tool <X> [--tool <Y>...]` replaces it.
- Plain `swamp repo upgrade` (no `--tool`) keeps `marker.tools` and re-syncs
  scaffolding for every enrolled tool.
- `--tool none` clears the list and cannot be combined with other tool values.
- Duplicate `--tool` values are deduped at the CLI.

When the list shrinks, scaffolding for dropped tools is not deleted, to avoid
destructive surprises. The renderer shows a "files were not deleted" note so the
user can clean up by hand.

The **primary tool** is `marker.tools[0]`, or `"claude"` for unenrolled repos
(`resolvePrimaryTool(marker)` in `src/domain/repo/primary_tool.ts`). Commands
that still work on one tool use it: audit recording
(`src/cli/commands/audit.ts`) and extension skills directory resolution
(`extension_list.ts`, `extension_rm.ts`). `swamp doctor audit` reads
`marker.tools[0]` directly with no `"claude"` fallback, and throws
`NoToolConfiguredError` when no tool is enrolled and `--tool` is absent
(`src/cli/commands/doctor_audit.ts`). Since the primary is the first entry,
appending a tool does not change it.

The `.swamp.yaml` marker migrates lazily: `RepoMarkerRepository.read()` turns the
legacy `tool: <single>` shape into `tools: [<single>]` and drops the old field.
The next marker write saves the new shape.

The compiled swamp binary should contain everything needed to initialize a
repository, including the skill files, so the CLI can write them out.

## Superseded Skill Detection

If the binary is upgraded without `swamp repo upgrade`, the repo keeps old skill
directories that the new version has merged. `SUPERSEDED_SKILLS` in
`superseded_skills.ts` lists their names.

On every repo-scoped command, the CLI checks the repo-local skill directories
from `supersededSkillDirs()` for superseded subdirectories and, if any exist,
emits a warning through the deferred-warning system. That list has one directory
per enrolled built-in tool, de-duplicated, and falls back to the primary tool's
directory (`.claude/skills`) when no tools are enrolled:

```
WRN 2 old swamp-managed skill(s) can be safely deleted: swamp-data-query, swamp-extension-model. These have been replaced by the bundled swamp skill. Run 'swamp repo upgrade' to remove them.
```

The check never blocks startup. `swamp repo upgrade` removes the directories
from the global skill directories, from custom tools' skill directories, and,
through `removeSupersededLocalSkills()`, from the same repo-local list the
warning checks. Both go through `resolveSupersededSkillDirs()`, which resolves
each directory's real path. A directory that resolves outside the repository,
such as a committed `.claude` symlink, is neither reported by the warning nor
cleaned by upgrade (upgrade logs that it skipped it). Upgrade deletes through
the resolved path. A skill directory whose path cannot be resolved, or an entry
that fails to delete, is logged without stopping the rest of the cleanup.

## Repository Layout

Source-of-truth files live in top-level directories tracked in git:

- **`models/`**: behavior definitions, `models/{normalized-type}/{name}.yaml`
  (legacy `{uuid}.yaml` also supported).
- **`workflows/`**: workflow definitions, `workflows/workflow-{name}.yaml`
  (legacy `workflow-{uuid}.yaml` also supported).
- **`vaults/`**: vault configurations, `vaults/{vault-type}/{id}.yaml`.
  `swamp repo init` creates the `default` local_encryption vault here unless
  run with `--no-vault` ([vaults](../primitives/vaults.md#the-default-vault)).
- **`grants/`**: declarative access grant files, `grants/{name}.yaml` or
  `grants/{name}.yml`. Each holds a `grants:` array of entries (subject,
  effect, actions, resource, optional condition). They are reconciled against
  stored `source: file:<filename>` grants on `swamp serve` startup and on
  `swamp access reload`. While the server runs, `GrantsDirectoryPoller`
  re-reconciles whenever files in the directory change
  (`src/domain/access/grants_directory_poller.ts`, wired in
  `src/cli/commands/serve.ts`).

Runtime data (versioned behavior data, workflow runs, method outputs, secrets)
goes through a datastore abstraction. The default datastore uses `.swamp/`; it
can also use an external filesystem path or S3. See
[datastores.md](../enablers/datastores.md).

## Configuration

A repo can be configured with an environment file whose attributes control how
swamp operations behave.

### Supported Configuration Options

Vault definitions are not `.swamp.yaml` keys. Each vault has its own
`vaults/{vault-type}/{id}.yaml` file (see Repository Layout). The full marker
key set is `RepoMarkerData` in
`src/infrastructure/persistence/repo_marker_repository.ts`. The user-facing
options are:

- `defaultVault`: the vault used when a method run or `swamp serve` names none.
  `swamp repo init` sets it to `default`, the vault it creates; a `--force`
  reinit keeps the value already recorded.
- `trustedCollectives`: collectives whose extensions auto-resolve on first use.
  Default `["swamp"]`; `[]` disables it. Managed with
  `swamp extension trust list/add/rm`.
- `trustMemberCollectives`: whether to also trust every collective the user
  belongs to (cached from `auth login`/`auth whoami`), on top of
  `trustedCollectives`. Default `false`. Toggled with
  `swamp extension trust auto-trust <on|off>`.
- `autoGc`: run garbage collection after method runs. Default `false`. When
  `true`, `collectGarbage` runs for the behavior that just ran, after reports
  finish and the result is shown, using each data item's declared
  `garbageCollection` policy (version-count caps and duration-based retention).
  Errors are logged and never fail the run. GC runs inside the `modelMethodRun`
  stream (`src/libswamp/models/run.ts`) before the CLI releases behavior locks
  and flushes datastore sync, so on a synced datastore the deletions go out in
  the same post-run push. With `autoGc` on, every write — including a workflow
  step's — also prunes versions beyond an integer `garbageCollection` cap; a
  workflow step gets no post-run pass. `swamp data gc` still does repo-wide
  manual GC.
- `garbageCollection`: how long each kind of history is kept, and whether
  swamp enforces it on its own (swamp-club#3473). See
  [Retention](#retention). Separate from `autoGc`, which trims one behavior's
  data versions by their declared policy.
- `serverAddress`: default `swamp serve` URL for the repo. When set, every
  serve-aware command uses it without `SWAMP_SERVE_URL` or `--server`.
  Precedence: `--server` flag > `SWAMP_SERVE_URL` env > `SWAMP_SERVER_URL` env >
  `.swamp.yaml serverAddress`. Set it with `swamp repo init --server <url>` or
  by editing `.swamp.yaml`. `repo init` refuses a URL with a username,
  password, query string or fragment, because `.swamp.yaml` is usually
  committed. The value is never used to authenticate: the token comes from
  `--token`, `SWAMP_SERVER_TOKEN`, `SWAMP_SERVER_TOKEN_FILE` or
  `~/.config/swamp/servers.json`. Keep credentials out of it when editing by
  hand too.

### Run Garbage Collection

`swamp run gc` removes old workflow-run records (`.swamp/workflow-runs/`) and
method outputs (`.swamp/outputs/`). `data gc` does not cover these; it
handles `.swamp/data/` (versioned data with lifetime/version policies).

- **Default retention**: the `garbageCollection` keys `workflowRuns`,
  `outputs` and `evaluatedSnapshots`, each falling back to `retention` (see
  [Retention](#retention)). Omitted values use 30 days
  (`DEFAULT_WORKFLOW_RUN_RETENTION_DAYS` and `DEFAULT_OUTPUT_RETENTION_DAYS`
  in `src/domain/data/run_lifecycle_service.ts`). `--older-than` overrides
  runs and outputs for one invocation; snapshots then follow their runs.
- **Terminal runs only**: only succeeded, failed or cancelled runs are deleted.
  Running and suspended workflow runs are never deleted, however old.
- **Run snapshots**: each collected run's evaluated-workflow snapshot
  (`.swamp/workflows-evaluated/runs/{run-id}/`) goes with it. A snapshot with
  no run record is an orphan and is removed once it is older than both the
  workflow-run retention and one hour (`MIN_ORPHAN_SNAPSHOT_AGE_MS`); the age
  guard exists because the snapshot is written before the run record's first
  save. `swamp workflow delete` removes the snapshots of the runs it deletes,
  after the runs. Run IDs always come from the `workflow-run-{run-id}.yaml`
  filenames, never from a record's body, and must be a single path segment.
  Orphan detection compares against the run records in the same datastore, so
  `workflow-runs` and `workflows-evaluated` must resolve to the same datastore
  (the default); split across tiers, snapshots of runs recorded elsewhere look
  orphaned once past retention.
- **Run logs**: an output's run log goes with it, found through the output's
  recorded `logFile`. Run logs are always written under the repo-local
  `.swamp/outputs/`, even when outputs are stored in a datastore. A `logFile`
  outside the output's own method directory is left alone: a workflow step's
  output points at its workflow run's log, which workflow-run gc removes.
  `swamp behavior delete` removes an output's run log the same way.
- **Orphaned run logs**: gc also removes run logs in the repo-local
  `.swamp/outputs/` that no remaining output references. These include logs
  left behind by earlier gc runs, and logs from runs that failed before saving
  an output. A direct method run writes its output record only when it
  finishes, so while it runs its log looks orphaned too. A log is swept only
  once it is past the retention cutoff and has not been written for 7 days,
  whatever `--older-than` or the method's `outputLifetime` says. A method
  directory holding a record gc cannot read keeps all its logs.
- **Flags**: `--dry-run`, `--force`, `--older-than <duration>` (uses
  `parseDuration`; units m, h, d, w, mo, y).
- **Automatic**: with `garbageCollection.automatic: true` the same
  collectors run on their own; see [Retention](#retention).

### Retention

`.swamp.yaml` `garbageCollection` sets how long each kind of history is kept
(swamp-club#3473):

```yaml
garbageCollection:
  retention: 30d          # default for every kind below
  automatic: true         # enforce it: serve timer, CLI end of command
  workflowRuns: 14d       # run records, run logs, wait records, claims
  evaluatedSnapshots: 3d  # optional; unset, snapshots go with their runs (orphans swept)
  outputs: 7d             # method outputs and their run logs
  data: 30d               # every data version, the latest included
  audit: 90d              # .swamp/audit logs; default for serve audit stores (with automatic on)
  bookkeeping: 24h        # serve worker GC grace, with automatic on (leases, dispatches, workers, enrollment tokens)
```

- **Units**: as `--older-than`: `m` is minutes and `mo` months, so
  `data: 6m` keeps six minutes of data, not six months. At most `1000y`;
  leave a key unset to keep that kind forever.
- **Precedence** (`RetentionPolicy`, `src/domain/retention/`): a one-off
  override (`--older-than`), then the kind's key, then `retention`. A kind
  with none of these is never reaped automatically; the manual commands keep
  their built-in defaults.
- **Validation** (`checkRetentionConfig`): positive durations only,
  `automatic` a boolean, an explicit `evaluatedSnapshots` not longer than
  the run retention. An unset `evaluatedSnapshots` follows the run
  retention rather than `retention`, so `retention: 30d` with
  `workflowRuns: 7d` is valid; only an explicit value removes a kept run's
  snapshot early, aged from the later of the snapshot and the run's finish. Unknown keys are logged once and ignored, as before.
- **What is never removed**: runs that have not finished (running,
  suspended, waiting, interrupted) and their snapshots; a finished nested
  run whose parent has not finished; data of the built-in access and serve
  state types (`swamp/server-token`, `grant`, `group`, `enrollment-token`,
  `worker`, `step-lease`, `pending-dispatch`, `fleet-probe`, see
  `retention_exemptions.ts`); a data name with a deferred write not yet
  promoted. Definitions, vaults and repo config are configuration, not
  history.
- **Data**: strict. A name whose latest version is older than the cutoff is
  deleted, version by version (so a version a serve run writes meanwhile
  survives and becomes latest), and `data.latest()` for a behavior that has
  not run within the window finds nothing. `retention` alone applies this
  too, in manual `swamp data gc` as well. Candidates come from the catalog's
  `created_at` index, not a scan. Grants and groups are exempt in both their
  stored spellings (`swamp/grant`, `@swamp/grant`).
- **Automatic passes** (`runRepoRetention`, `src/libswamp/retention/`): the
  collectors run in order (runs, snapshots, outputs, data, audit), in
  batches of 100. Each batch is traced (`swamp.retention.batch`).
  - `swamp serve` runs `RetentionGcService` five minutes after start and then
    hourly. It reads `.swamp.yaml` each tick, takes the sync gate per batch
    (never for the whole pass), backs off while every run slot is taken,
    shares a mutex with `run.gc` and `data.gc` (taken before the sync gate,
    in that order everywhere), claims the hour only once it holds the
    mutex, and writes one
    `retention.pass` system audit event per pass. Of several serves on one
    datastore, the one that claims the hour (`putIfAbsent` on
    `_control/retention/claims/<hour>`) runs it.
  - A CLI command that opened the repository to write runs a pass in
    teardown, after its own locks are released (`runRetentionAtCommandEnd`,
    `src/cli/retention_teardown.ts`): at most hourly per checkout
    (`.swamp/retention-last-attempt.json`) and per datastore (the same hourly
    claim), taking the datastore lock through `requireInitializedRepo` with a
    2-second wait (`lockWaitMs`), stopping after 10 seconds of batches and
    capping its v3 compaction and chunk sweep at 10 seconds each. A failure
    after the lock was taken releases it at once.
    Read-only commands, hook mode and `swamp serve` itself never run one. A
    failure is logged at debug and never fails the command.
- **Without `automatic`**: the keys only set the manual commands' defaults
  (`swamp run gc`, `swamp data gc`); audit logs keep their 7 days and serve's
  worker GC its 24-hour grace.
- **Watermarks**: one record per kind at `_control/retention/watermarks/<kind>`
  in the datastore (below the namespace; the extension's control plane on a
  custom datastore), overwritten on each pass: cutoff, retention, last pass,
  counts, and whether the pass finished. A kind a stopped pass never reached
  keeps its previous record. Lookups of a missing run, output or data item
  add "items before `<cutoff>` have been reaped by retention" once that
  kind's last pass finished, reading the record with a 2-second deadline.
- **Proof**: `swamp doctor datastores --retention` scans storage for items
  past their cutoff and fails with the list; with `automatic` on it allows
  two hours past the cutoff (one pass interval and slack). Serve health
  shows each kind's watermark.
- **v3 datastores**: a removal is a new commit, and the removed content stays
  in history until that commit is folded. Each pass compacts history older
  than the 7-day outbox window (`compactRetentionQuietly`) and sweeps chunks
  after their 24-hour grace, so reaped content leaves a v3 datastore within
  about 8 days of being reaped.

## RepoIndexService

The RepoIndexService is a domain event handler for aggregate repository
changes. It is currently a no-op (`NoopRepoIndexService`); the old
symlink-based logical views are gone. Repositories still emit domain events,
which future event-driven features can use.

### Domain Events

Aggregate repositories emit these events when data changes:

**Behavior Events:**

- `ModelCreated` - A new behavior definition was created
- `ModelUpdated` - A behavior definition or data was modified
- `ModelDeleted` - A behavior was deleted

**Definition Events:**

- `DefinitionCreated` - A new definition was created
- `DefinitionUpdated` - A definition was modified
- `DefinitionDeleted` - A definition was deleted

**Workflow Events:**

- `WorkflowCreated` - A new workflow definition was created
- `WorkflowUpdated` - A workflow definition was modified
- `WorkflowDeleted` - A workflow was deleted

**WorkflowRun Events:**

- `WorkflowRunStarted` - A workflow run began execution
- `WorkflowRunCompleted` - A workflow run completed successfully
- `WorkflowRunFailed` - A workflow run failed

**Vault Events:**

- `VaultCreated` - A new vault was created
- `VaultUpdated` - A vault configuration was modified
- `VaultDeleted` - A vault was deleted
- `VaultSecretUpdated` - A secret was stored or updated in a vault
- `VaultSecretDeleted` - A secret was deleted from a vault
- `VaultSecretRead` - A secret was read from a vault
- `VaultSecretAnnotated` - A secret's annotation was updated

### Event Handling

When an aggregate repository emits an event:

1. The repository saves the aggregate (definitions to top-level directories,
   runtime data to the datastore).
2. It emits the matching domain event.
3. The RepoIndexService receives it (currently a no-op).

### Directory Structure

**Behavior definitions (`models/`):**

```
models/{normalized-type}/{name}.yaml
```

Real files, not symlinks, tracked in git. Legacy `{uuid}.yaml` files also work
and are renamed to name-based filenames on save.

**Workflow definitions (`workflows/`):**

```
workflows/workflow-{name}.yaml
```

Real files, not symlinks, tracked in git.

**Runtime data (datastore, default `.swamp/`):**

```
.swamp/data/{normalized-type}/{model-id}/{data-name}/{version}/
.swamp/outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml
.swamp/workflow-runs/{workflow-id}/workflow-run-{run-id}.yaml
```

`swamp run gc` covers the `workflow-runs/` and `outputs/` directories, plus the
per-run snapshots under `workflows-evaluated/runs/` (see
[Run Garbage Collection](#run-garbage-collection) above).

See [datastores.md](../enablers/datastores.md) for how the datastore path is
resolved.
