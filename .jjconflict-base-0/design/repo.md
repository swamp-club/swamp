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

## Internal storage directory (.swamp/)

Swamp repos store information from the various infrastructure repositories (in
the domain driven design sense) in the `.swamp/` directory. This is the internal
format for swamp data.

Both agents and humans are free to explore the `.swamp/` directory, but it is
laid out in a way that is useful for swamp's internal software architecture.

## Logical view

The swamp repo represents a logical view into the `.swamp/` directory that is
useful for humans and agents. It is constructed by making symlinks into
information in the `.swamp/` directory, laid out in ways that make sense for
exploration of the information.

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

## Configuration

The swamp repo can be configured with an environment file that can specify
attributes to control the behaviour of the swamp operations.

### Supported Configuration Options

- `vaults`: The swamp vault key specifies stores where sensitive data can be
  sent to and retrieved from when evaluating and running workflow steps.
  Multitple vaults can be specified for a each swamp repository.

## RepoIndexService

The RepoIndexService is a domain event handler that maintains the logical views
(read models) whenever aggregate repositories mutate data.

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

1. The repository persists the aggregate to the `.swamp/` directory
2. The repository emits the appropriate domain event
3. The RepoIndexService receives the event
4. The RepoIndexService updates the relevant logical views (symlinks)

### Logical View Structure

The RepoIndexService maintains two primary logical views:

**Model View (`/models/`):**

```
/models/{model-name}/
  definition.yaml              → /.swamp/definitions/{type}/{id}.yaml
  type/
    logs/                      → symlinks to data with type=log tag
    files/                     → symlinks to data with type=file tag
    resources/                 → symlinks to data with type=resource tag
  {tag-key}/{tag-value}/       → data organized by custom tag key/value pairs
  outputs/
    {method}/                  → /.swamp/outputs/{type}/{method}/
```

See [./models.md] for detailed data structure including versioning, metadata,
and data tags.

**Workflow View (`/workflows/`):**

```
/workflows/{workflow-name}/
  workflow.yaml              → /.swamp/workflows/workflow-{id}.yaml
  runs/
    latest/                  → {latest-timestamp}/
    {timestamp}/
      run.yaml               → /.swamp/workflow-runs/{workflow-id}/workflow-run-{run-id}.yaml
      steps/
        {step-name}/
          output.yaml        → symlink to step output
          model/             → ../models/{model-name}/ (for model method steps)
```

### Symlink Naming Conventions

- Model logical views use the model's unique `name` as the directory name
- Workflow logical views use the workflow's unique `name` as the directory name
- Run directories use a shortened run ID or timestamp-based identifier
- All symlinks point to absolute paths within the `.swamp/` directory
