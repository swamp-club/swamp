# Data Concepts

## What is Behavior Data?

Behaviors produce data when methods execute. Each data item has:

- **Name**: Unique identifier within the behavior
- **Version**: Auto-incrementing integer (starts at 1)
- **Lifetime**: How long data persists
- **Content type**: MIME type of the data
- **Tags**: Key-value pairs for categorization (e.g., `type=resource`)

## Data Tags

Standard tags categorize data:

| Tag               | Description                                     |
| ----------------- | ----------------------------------------------- |
| `type=resource`   | Structured JSON data (validated against schema) |
| `type=file`       | Binary/text file artifacts (including logs)     |
| `specName=<name>` | Output spec key name (for `data.findBySpec()`)  |

Tag keys starting with `_swamp.` are reserved for swamp. `behavior validate` and
`workflow validate` fail on one in a definition, spec, workflow or data output
override, and a run refuses it, `--tag` included; never write them.

## Lifetime Types

Data lifetime controls automatic expiration:

| Lifetime    | Effect                                                |
| ----------- | ----------------------------------------------------- |
| `ephemeral` | Deleted after method invocation or workflow completes |
| `job`       | Persists only while the creating job runs             |
| `workflow`  | Persists only while the creating workflow runs        |
| Duration    | Expires after time period (e.g., `1h`, `7d`, `1mo`)   |
| `infinite`  | Never expires (default for resources)                 |

## Version Garbage Collection

Each data item can have multiple versions. The GC setting controls version
retention:

| GC Setting  | Effect                                |
| ----------- | ------------------------------------- |
| Integer (N) | Keep only the latest N versions       |
| Duration    | Keep versions newer than the duration |
| `infinite`  | Keep all versions forever             |
