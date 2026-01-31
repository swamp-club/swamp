# Workflows

The workflow is the overall definition of what to execution, represented by a
_Workflow Run_.

Each workflow is made up of one or more _jobs_.

Jobs are made up for one or more _steps_, where a step can be calling a method
on a model or a shell command to execute. Jobs can be dependent on each other,
and only execute if their dependcy condition is met (for example, only run this
job if one of its upstream dependencies fail).

Within a job, steps are executed with a weighted topological sort, so that they
have maximum paralleism through the job.

Jobs can have dependencies on other jobs. The entire workflow is executed with a
weighted topological sort, so thtat htye have maximum paralleism through the
workflow. Like steps, jobs also have conditions that trigger them.

Workflows are specified in YAML files, that are validated with Zod, in the
`/data/workflows/` directory of the repository, with their `{uuid}.yaml`.
Workflow run output is stored in `/data/workflow-runs/` at
`/data/workflow-runs/{workflow-uuid}/{run-uuid}.yaml`.

## Workflow Definition

Workflows are specified in `/data/workflows/{uuid}.yaml`. They have a unique id,
a globally unique name, and a set of jobs.

## Jobs

Each job has a name, a description, a series of steps, and an array of objects
that specify other jobs it depends on that also includes the trigger for this
job to execute. For example, you can specify that job C depends on job A and B,
and it triggers only if job A or job B fail. You should be able to express
complex boolean trigger logic.

## Steps

Each step has a name, a descirption, and a task (which is either a method on a
model to run or a shell command to execute. Each step has dependency logic that
is identical to jobs, only for steps rather than jobs.

## Workflow Runs

When a workflow is run, it executes the jobs and steps in the correct order. The
order should be topologically sorted for dependencies, and weighted so it does
not vary between identical inputs. (If the inputs are identical, the run order
should be deterministic.)

The output of the run will be written to a workflow run log, kept in
`/data/workflow-runs/{workflow-uuid}/{run-uuid}.yaml`.

## Logical Views

The RepoIndexService maintains a workflow-centric logical view at `/workflows/`
that provides human/agent-friendly exploration of workflows by name.

### Workflow View Structure

```
/workflows/{workflow-name}/
  workflow.yaml   → symlink to /data/workflows/{uuid}.yaml
  runs/
    {run-id}/
      run.yaml    → symlink to /data/workflow-runs/{workflow-uuid}/{run-uuid}.yaml
      steps/
        {step-name}/
          output.yaml → symlink to step output
          model/      → symlink to /models/{model-name}/ (for model method steps)
```

This structure allows exploring workflow definitions and their run history using
human-readable names.

### Cross-View References

When a workflow step executes a model method, the output appears in both views:

- **Model view:** `/models/{model-name}/outputs/{method}/` contains the method
  output
- **Workflow view:** `/workflows/{workflow-name}/runs/{run-id}/steps/{step}/`
  contains a symlink to the same output, plus a reference to the model's logical
  view

This enables exploration from either the model's perspective or the workflow's
perspective.

### Domain Events

The WorkflowRepository and WorkflowRunRepository emit domain events:

**Workflow Events:**

- `WorkflowCreated` - Emitted when a new workflow is created via
  `workflow create`
- `WorkflowUpdated` - Emitted when a workflow definition is modified
- `WorkflowDeleted` - Emitted when a workflow is deleted

**WorkflowRun Events:**

- `WorkflowRunStarted` - Emitted when `workflow run` begins execution
- `WorkflowRunCompleted` - Emitted when a workflow run completes successfully
- `WorkflowRunFailed` - Emitted when a workflow run fails

The RepoIndexService subscribes to these events and updates the logical views
accordingly, ensuring the `/workflows/` view stays synchronized with the data
directory.

## CLI Commands

### workflow create <name>

Creates a new workflow file with and id and the specified name.

### workflow validate <name>

Works like model validate does, only it validates workflow files. Should
validate all workflows if none is specified.

### workflow search <search>

Should work similarly to swamp type search - it uses fzf to search across all
the workflows by name or by id. Should produce json output or use interactive
fuzzy search.

### workflow get <id or name>

Should show the workflow yaml with syntax highlighting, and the path, similar to
`model get`.

### workflow run <id or name>

Executes a workflow run.

### workflow edit [id or name]

Opens the workflow file in the user's preferred editor.

If no workflow is specified interactively, shows a search interface.

Editor selection: Uses $EDITOR if set, otherwise falls back to: vscode, zed,
nvim, vim, nano, emacs.

### workflow history get <id or name>

Displays the run data (status, timing, step outputs/errors) for the latest
workflow run

### workflow history search <id or name>

Should work similarly to workflow search - it uses fzf to search across all the
workflow runs by name or by id. Should produce json output or use interactive
fuzzy search.

### workflow schema get

Gets the schema for workflow files. Model it after `type describe` - used by the
agent to understand how to write valid workflow files
