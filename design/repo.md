# swamp repo

A swamp repo contains all of the models and code for automating tasks with
swamp.

Swamp repo's can be initalized, where the needed directories, and the swamp-*
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

## Data directory

Swamp repos store information from the various infrastructure repositories (in
the domain driven design sense) in the 'data' directory. This is the internal
format for swamp data.

Both agents and humans are free to explore the data directory, but it is laid
out in a way that is useful for swamps internal software architecture.

## Logical view

The swamp repo represents a logical view into the data directory that is useful
for humans and agents. It is constructed by making symlinks into information in
the data directory, laid out in ways that make sense for exploration of the
information.

For example, a person might want to explore the outputs of a given method run on
a model both from the perspective of that model and from the perspective of the
workflow that triggered it. There should be a logical directory called 'models'
that shows the model perspective, and one called 'workflows' that shows it from
the perspective of workflows and workflow runs.

### Constructing logical views

Logical views should be constructed automatically when any mutation occurs in an
entity repository, by calling an logical index service that maintains the tree.

So any time a change is made through a given entities repository, the index
service will analyze the repo and update the logical views, ensuring they are
always up to date.

## CLI Commands

### repo init <path>

Initalizes a new swamp repo, and defaults to the current working directory if no
path is provided.

Writes the swamp version to the marker file.

### repo upgrade <path>

Should pull the new skills into the repo from the swamp binary and update the
files in the repository.

### repo index

Should update the logical views through the same mechanism the entity
repositories use. This is the equivalent of "event replay" - it rebuilds all
read models (logical views) by scanning the data directory.

## RepoIndexService

The RepoIndexService is a domain event handler that maintains the logical views
(read models) whenever aggregate repositories mutate data.

### Domain Events

Aggregate repositories emit domain events when data changes:

**Model Events:**

- `ModelCreated` - A new model input was created
- `ModelUpdated` - A model input or resource was modified
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

1. The repository persists the aggregate to the data directory
2. The repository emits the appropriate domain event
3. The RepoIndexService receives the event
4. The RepoIndexService updates the relevant logical views (symlinks)

### Logical View Structure

The RepoIndexService maintains two primary logical views:

**Model View (`/models/`):**

```
/models/{model-name}/
  input.yaml → /data/inputs/{type}/{id}.yaml
  resource.yaml → /data/resources/{type}/{id}.yaml
  data.yaml → /data/data/{type}/{id}.yaml
  logs/ → /data/logs/{type}/{id}/
  files/ → /data/files/{type}/{id}/
  outputs/
    {method}/ → /data/outputs/{type}/{method}/{id}-{timestamp}.yaml
```

**Workflow View (`/workflows/`):**

```
/workflows/{workflow-name}/
  workflow.yaml → /data/workflows/{id}.yaml
  runs/
    latest/ -> (points to latest timestamp)
    {timestamp}/
      run.yaml → /data/workflow-runs/{workflow-id}/{run-id}.yaml
      steps/
        {step-name}/
          output.yaml → symlink to step output
          model/ → symlink to model logical view (for model method steps)
```

### Symlink Naming Conventions

- Model logical views use the model's unique `name` as the directory name
- Workflow logical views use the workflow's unique `name` as the directory name
- Run directories use a shortened run ID or timestamp-based identifier
- All symlinks point to absolute paths within the data directory
