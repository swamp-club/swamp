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
