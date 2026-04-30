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

## Repository Layout

Source-of-truth files live in top-level directories tracked in git:

- **`models/`** — Model definitions: `models/{normalized-type}/{id}.yaml`
- **`workflows/`** — Workflow definitions: `workflows/workflow-{id}.yaml`
- **`vaults/`** — Vault configurations: `vaults/{vault-type}/{id}.yaml`

Runtime data (versioned model data, workflow runs, method outputs, secrets) is
stored through a datastore abstraction. The default datastore uses the `.swamp/`
directory, but it can be configured to use an external filesystem path or S3.
See [./datastores.md] for details.

## Configuration

The swamp repo can be configured with an environment file that can specify
attributes to control the behaviour of the swamp operations.

### Supported Configuration Options

- `vaults`: The swamp vault key specifies stores where sensitive data can be
  sent to and retrieved from when evaluating and running workflow steps.
  Multitple vaults can be specified for a each swamp repository.
- `trustedCollectives`: List of collectives whose extensions auto-resolve on
  first use. Default: `["swamp", "si"]`. Set to `[]` to disable. Manageable via
  `swamp extension trust list/add/rm`.
- `trustMemberCollectives`: Whether to auto-trust collectives the user belongs
  to (cached from `auth login`/`auth whoami`). Default: `true`. Set to `false`
  to only trust the explicit `trustedCollectives` list. Toggleable via
  `swamp extension trust auto-trust <on|off>`.

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

**Workflow Events:**

- `WorkflowCreated` - A new workflow definition was created
- `WorkflowUpdated` - A workflow definition was modified
- `WorkflowDeleted` - A workflow was deleted

**WorkflowRun Events:**

- `WorkflowRunStarted` - A workflow run began execution
- `WorkflowRunCompleted` - A workflow run completed successfully
- `WorkflowRunFailed` - A workflow run failed

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
.swamp/workflow-runs/{workflow-id}/{run-id}.yaml
```

See [./datastores.md] for how the datastore path is resolved.
