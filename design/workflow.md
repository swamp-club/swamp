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

Workflows are specified in YAML files, that are validated with zod, in a
workflows/ directory of the repository, with their workflow-{uuid}.yaml.
Workflow run output is in subdirectories of workflows at
workfows/workflow-{uuid}/workflow-run-{uuid}-{timestamp}.yaml.

## Workflow Definition

Workflows are specified in workflows/workflow-{uuid}.yaml. They have a unique
id, a globally unique name, and a set of jobs.

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
workflows/workflow-{uuid}/workflow-run-{uuid}-{timestamp}.yaml

## CLI Commands

### workflow create <name>

Creates a new workflow file with and id and the specified name.

### workflow validate <name>

Works like model validate does, only it validates workflow files. Should
validate all workflows if none is specified.

### workflow search <search>

Should work simiilarly to swamp type search - it uses fzf to search across all
the workflows by name or by id. Should produce json output or use interactive
fuzzy search.

### workflow get <id or name>

Should show the workflow yaml with syntax highlighting, and the path, similar to
`model get`.

### workflow run <id or name>

Executes a workflow run.

### workflow schema get

Gets the schema for workflow files. Model it after `type describe` - used by the
agent to understand how to write valid workflow files
