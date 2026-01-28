# AI Agent

The primary method for working with swamp is through an AI agent. Each
repository will have skills dedicated to working with swamp, through the cli,
writing files, etc.

## Model Skill

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

Use `swamp model method run`.
