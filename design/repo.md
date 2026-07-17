# swamp repo

A swamp repo contains all of the models and code for automating tasks with
swamp.

Swamp repo's can be initalized, where the needed directories, and the swamp-\*
skills will be copied in.

They can be upgraded, where the skills and anything else that is needed can move
from one version to another.

They should have a `.swamp.yaml` file at the top of the repo with the current
swamp version it was initialized/upgraded with.

It should write a CLAUDE.md that describes the purpose of the repository as
building automation with swamp, and describes when to use the linked skills. The
agent should attempt to use swamp for most tasks.

## Multi-tool Repos

A swamp repo can be enrolled for multiple AI agent tools at once (Claude
Code, Cursor, OpenCode, Codex, Copilot, Kiro). The marker file stores the
full enrolled list as `tools: AiTool[]`. Each tool's scaffolding (skills
directory, instructions file, settings/hooks) is written independently
since the paths don't conflict.

`swamp repo init --tool <X> [--tool <Y>...]` sets the enrolled tool list.
`swamp repo upgrade --tool <X> [--tool <Y>...]` replaces it; plain
`swamp repo upgrade` (no `--tool`) preserves `marker.tools` and re-syncs
scaffolding for every enrolled tool. `--tool none` clears the list. Duplicate
`--tool` values are deduped at the CLI; `--tool none` cannot be combined with
other tool values.

When the enrolled list shrinks, on-disk scaffolding for dropped tools is
**not** deleted — the renderer surfaces a "files were not deleted" note so
the user can clean up by hand. This avoids destructive surprises.

The **primary tool** is `marker.tools[0]` (or `"claude"` as a fallback for
unenrolled repos), resolved via `resolvePrimaryTool(marker)` in
`src/domain/repo/primary_tool.ts`. Commands that still operate on a single
tool — audit recording, extension skills directory resolution, doctor checks
— consume it. The first-in-array rule means appending a tool keeps the
existing primary stable.

The `.swamp.yaml` marker uses lazy migration for backwards compat: the read
normalizer in `RepoMarkerRepository.read()` promotes the legacy `tool:
<single>` shape into `tools: [<single>]` and strips the legacy field. The
next marker write persists the new shape.

The compiled swamp binary should include everything it needs to initialize a
repository, including the skill files, so that they can be written out by the
cli.

## Superseded Skill Detection

When the CLI binary is upgraded but `swamp repo upgrade` is not run, the
repo retains old skill directories that have been consolidated in the new
version. The `SUPERSEDED_SKILLS` constant in `superseded_skills.ts` lists these
directory names.

On every CLI startup (for repo-scoped commands), the CLI checks all enrolled
tools' skill directories for superseded subdirectories. If any are found, a
warning is emitted via the deferred-warning system:

```
WRN 2 old swamp-managed skill(s) can be safely deleted: swamp-data-query, swamp-extension-model. These have been replaced by the bundled swamp skill. Run 'swamp repo upgrade' to remove them.
```

This check is non-fatal — it never blocks startup. `swamp repo upgrade`
removes the superseded directories via `removeSupersededSkills()`.

## Repository Layout

Source-of-truth files live in top-level directories tracked in git:

- **`models/`** — Model definitions: `models/{normalized-type}/{id}.yaml`
- **`workflows/`** — Workflow definitions: `workflows/workflow-{id}.yaml`
- **`vaults/`** — Vault configurations: `vaults/{vault-type}/{id}.yaml`
- **`grants/`** — Declarative access grant files: `grants/{name}.yaml` or
  `grants/{name}.yml`. Each file contains a `grants:` array of grant entries
  (subject, effect, actions, resource, optional condition). Reconciled against
  stored `source: file:<filename>` grants on `swamp serve` startup and
  `swamp access reload`.

Runtime data (versioned model data, workflow runs, method outputs, secrets) is
stored through a datastore abstraction. The default datastore uses the `.swamp/`
directory, but it can be configured to use an external filesystem path or S3.
See [datastores.md](./datastores.md) for details.

## Configuration

The swamp repo can be configured with an environment file that can specify
attributes to control the behaviour of the swamp operations.

### Supported Configuration Options

- `vaults`: The swamp vault key specifies stores where sensitive data can be
  sent to and retrieved from when evaluating and running workflow steps.
  Multitple vaults can be specified for a each swamp repository.
- `trustedCollectives`: List of collectives whose extensions auto-resolve on
  first use. Default: `["swamp"]`. Set to `[]` to disable. Manageable via
  `swamp extension trust list/add/rm`.
- `trustMemberCollectives`: Whether to auto-trust collectives the user belongs
  to (cached from `auth login`/`auth whoami`). Default: `true`. Set to `false`
  to only trust the explicit `trustedCollectives` list. Toggleable via
  `swamp extension trust auto-trust <on|off>`.
- `autoGc`: Enable automatic garbage collection after model method runs.
  Default: `false`. When `true`, `collectGarbage` runs for the model that just
  executed after reports complete and the method result is shown. Reuses each
  data item's declared `garbageCollection` policy (version-count caps and
  duration-based retention). Errors are logged but never fail the method run.
  The sync push includes GC deletions so the current push benefits immediately.
  `swamp data gc` remains available for repo-wide manual GC.

### Run Garbage Collection

`swamp run gc` garbage-collects old workflow-run records
(`.swamp/workflow-runs/`) and model method outputs (`.swamp/outputs/`). These
two runtime artifact stores are not covered by `data gc`, which handles
`.swamp/data/` (versioned data with lifetime/version policies).

- **Default retention**: 30 days (`DEFAULT_WORKFLOW_RUN_RETENTION_DAYS` and
  `DEFAULT_OUTPUT_RETENTION_DAYS` in
  `src/domain/data/run_lifecycle_service.ts`)
- **Terminal runs only**: Only runs in a terminal state (succeeded, failed,
  cancelled) are deleted. Running and suspended workflow runs are never deleted
  regardless of age.
- **Flags**: `--dry-run`, `--force`, `--older-than <duration>` (reuses
  `parseDuration` -- units: m, h, d, w, mo, y)
- **Manual-only**: There is no automated or post-run GC for these stores yet.
  `swamp run gc` is currently the only way to clean them up.

## RepoIndexService

The RepoIndexService is a domain event handler that responds to aggregate
repository mutations. It is currently a noop implementation
(`NoopRepoIndexService`) — the old symlink-based logical views have been
removed. Domain events are still emitted by repositories and can be used for
future event-driven features.

### Domain Events

Aggregate repositories emit domain events when data changes:

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

1. The repository persists the aggregate (definitions to top-level directories,
   runtime data to the datastore)
2. The repository emits the appropriate domain event
3. The RepoIndexService receives the event (currently a noop)

### Directory Structure

**Model definitions (`models/`):**

```
models/{normalized-type}/{id}.yaml
```

These are real files (not symlinks) tracked in git.

**Workflow definitions (`workflows/`):**

```
workflows/workflow-{id}.yaml
```

These are real files (not symlinks) tracked in git.

**Runtime data (datastore, default `.swamp/`):**

```
.swamp/data/{normalized-type}/{model-id}/{data-name}/{version}/
.swamp/outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml
.swamp/workflow-runs/{workflow-id}/workflow-run-{run-id}.yaml
```

The `workflow-runs/` and `outputs/` directories are covered by `swamp run gc`
(see [Run Garbage Collection](#run-garbage-collection) above).

See [datastores.md](./datastores.md) for how the datastore path is resolved.
