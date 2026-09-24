---
audience: maintainer, operator
last-verified: 2026-09-07 @ 58652907
---

# swamp repo

A swamp repo holds all the models and code for automating tasks with swamp.

Initializing a repo creates the needed directories and copies in the swamp-\*
skills. Upgrading a repo moves the skills, and anything else that needs it, from
one version to the next.

The repo should have a `.swamp.yaml` file at its root recording the swamp
version it was initialized or upgraded with.

Init should write a CLAUDE.md that says the repository is for building
automation with swamp and when to use the linked skills. The agent should try to
use swamp for most tasks.

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

On every repo-scoped command, the CLI checks each enrolled tool's skill
directory for superseded subdirectories and, if any exist, emits a warning
through the deferred-warning system:

```
WRN 2 old swamp-managed skill(s) can be safely deleted: swamp-data-query, swamp-extension-model. These have been replaced by the bundled swamp skill. Run 'swamp repo upgrade' to remove them.
```

The check never blocks startup. `swamp repo upgrade` removes the directories
with `removeSupersededSkills()`.

## Repository Layout

Source-of-truth files live in top-level directories tracked in git:

- **`models/`**: model definitions, `models/{normalized-type}/{name}.yaml`
  (legacy `{uuid}.yaml` also supported).
- **`workflows/`**: workflow definitions, `workflows/workflow-{name}.yaml`
  (legacy `workflow-{uuid}.yaml` also supported).
- **`vaults/`**: vault configurations, `vaults/{vault-type}/{id}.yaml`.
- **`grants/`**: declarative access grant files, `grants/{name}.yaml` or
  `grants/{name}.yml`. Each holds a `grants:` array of entries (subject,
  effect, actions, resource, optional condition). They are reconciled against
  stored `source: file:<filename>` grants on `swamp serve` startup and on
  `swamp access reload`. While the server runs, `GrantsDirectoryPoller`
  re-reconciles whenever files in the directory change
  (`src/domain/access/grants_directory_poller.ts`, wired in
  `src/cli/commands/serve.ts`).

Runtime data (versioned model data, workflow runs, method outputs, secrets) goes
through a datastore abstraction. The default datastore uses `.swamp/`; it can
also use an external filesystem path or S3. See
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
- `trustedCollectives`: collectives whose extensions auto-resolve on first use.
  Default `["swamp"]`; `[]` disables it. Managed with
  `swamp extension trust list/add/rm`.
- `trustMemberCollectives`: whether to also trust every collective the user
  belongs to (cached from `auth login`/`auth whoami`), on top of
  `trustedCollectives`. Default `false`. Toggled with
  `swamp extension trust auto-trust <on|off>`.
- `autoGc`: run garbage collection after model method runs. Default `false`.
  When `true`, `collectGarbage` runs for the model that just ran, after reports
  finish and the result is shown, using each data item's declared
  `garbageCollection` policy (version-count caps and duration-based retention).
  Errors are logged and never fail the run. GC runs inside the `modelMethodRun`
  stream (`src/libswamp/models/run.ts`) before the CLI releases model locks and
  flushes datastore sync, so on a synced datastore the deletions go out in the
  same post-run push. `swamp data gc` still does repo-wide manual GC.
- `garbageCollection`: repository defaults for manual `swamp run gc` cleanup.
  `workflowRuns` and `outputs` take positive durations such as `7d` or `2w`;
  omitted values keep the 30-day default. It does not run cleanup on its own or
  change model data's `autoGc` behavior.
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
model method outputs (`.swamp/outputs/`). `data gc` does not cover these; it
handles `.swamp/data/` (versioned data with lifetime/version policies).

- **Default retention**: `.swamp.yaml` can configure independent values:
  ```yaml
  garbageCollection:
    workflowRuns: 7d
    outputs: 1d
  ```
  Omitted values use 30 days (`DEFAULT_WORKFLOW_RUN_RETENTION_DAYS` and
  `DEFAULT_OUTPUT_RETENTION_DAYS` in
  `src/domain/data/run_lifecycle_service.ts`). `--older-than` overrides both
  for one invocation.
- **Terminal runs only**: only succeeded, failed or cancelled runs are deleted.
  Running and suspended workflow runs are never deleted, however old.
- **Run logs**: an output's run log goes with it, found through the output's
  recorded `logFile`. Run logs are always written under the repo-local
  `.swamp/outputs/`, even when outputs are stored in a datastore. A `logFile`
  outside the output's own method directory is left alone: a workflow step's
  output points at its workflow run's log, which workflow-run gc removes.
  `swamp model delete` removes an output's run log the same way.
- **Orphaned run logs**: gc also removes run logs in the repo-local
  `.swamp/outputs/` that no remaining output references. These include logs
  left behind by earlier gc runs, and logs from runs that failed before saving
  an output. A direct model method run writes its output record only when it
  finishes, so while it runs its log looks orphaned too. A log is swept only
  once it is past the retention cutoff and has not been written for 7 days,
  whatever `--older-than` or the method's `outputLifetime` says. A method
  directory holding a record gc cannot read keeps all its logs.
- **Flags**: `--dry-run`, `--force`, `--older-than <duration>` (uses
  `parseDuration`; units m, h, d, w, mo, y).
- **Manual-only**: nothing cleans these stores automatically or after a run
  yet. `swamp run gc` is the only way.

## RepoIndexService

The RepoIndexService is a domain event handler for aggregate repository
changes. It is currently a no-op (`NoopRepoIndexService`); the old
symlink-based logical views are gone. Repositories still emit domain events,
which future event-driven features can use.

### Domain Events

Aggregate repositories emit these events when data changes:

**Model Events:**

- `ModelCreated` - A new model definition was created
- `ModelUpdated` - A model definition or data was modified
- `ModelDeleted` - A model was deleted

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

**Model definitions (`models/`):**

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

`swamp run gc` covers the `workflow-runs/` and `outputs/` directories (see
[Run Garbage Collection](#run-garbage-collection) above).

See [datastores.md](../enablers/datastores.md) for how the datastore path is
resolved.
