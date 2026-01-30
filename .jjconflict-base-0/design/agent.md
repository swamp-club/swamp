# AI Agent

The primary method for working with swamp is through an AI agent. Each
repository will have skills dedicated to working with swamp, through the cli,
writing files, etc.

## swamp-model Skill

This skill understands how to work with models. It will be able to:

### Search for model types

Use the `swamp type search --json` command, and select the correct type.

### Describe specific model types

Learn the shape and validations for inputs, resources, and callable methods for
a model with `swamp type describe --json`.

### Create model inputs

Use `swamp model create --json` command to create a new model input, according
to the type description from `swamp type describe`.

Then edit the resulting file and set any attributes or metadata that is
neccessary.

### Run individual methods

Use `swamp model method run` to run methods, then look at the resulting resource
and report on what happened.

## swamp-workflow Skill

This skill knows how to write and run workflows.

### Search for existing workflows

Find existing workflows to work with using `swamp workflow search --json` and
the fuzzy query syntax.

### Get an existing workflow

Get an existing worfklow by calling `swamp workflow get --json`, then reading
the file directly from its path.

### Create a new workflow

Create a new workflow by calling `swamp workflow create <name> --json`. Then
edit the resulting file directly.

### Validate a workflow

Any time you make a change to a workflow, you must validate it with
`swamp workflow validate --json`.

### Summarize a workflow

Read a workflow file, and write a summary of what will happen when it is
executed.

### Run a workflow

Execute a workflow with `swamp workflow run <name> --json`, and summarize the
results by reading the output and the resulting workflow logs.
