# Models

A model in swamp is defined by a _type_. They are instantiated by creating a
_definition_, whose global arguments can be set statically or dynamically
through _inputs_. An instantiated _model_ can be used through calling _methods_,
which _output_ their results and can store _resources_ and _files_. Each method
also declares its own _arguments_ schema, and at execution time receives the
merged set of global arguments and per-method arguments. Resources are
structured data with a schema, and files are raw content with a content type.
Both are immutable, have a _lifetime_, can be _tagged_ with capabilities, and
store the _definition_ that created it (so the model can be instantiated from
the data it produces). Data produced by a model can only be written again by an
instantiated model with the same definition as the original data.

## Type

All models in swamp are of a unique _type_. Types are defined by the thing that
they model - for example, a swamp model to manage AWS VPCs using the Cloud
Control API would be named 'AWS::EC2::VPC', because that is what the cloud
control api calls it. They should map semantically to the domain.

They _must_ include a domain identifier at the start of the type. For example:

AWS: AWS::EC2::VPC, AWS::Budget::Budgets Docker CLI: docker run, docker pull
Azure: Microsoft.Resources/resourceGroup

Each type also has a normalized representation, where special characters are
mapped into directory structures like 'aws/ec2/vpc' or 'docker/run' or
'microsoft/resources/resourceGroup'.

## ID

Each instance of a model has a unique ID that is a uuidv4.

## Version

Each model has a version using **CalVer** format `YYYY.MM.DD.MICRO` (e.g.,
`"2025.01.15.1"`, `"2025.06.01.3"`). The micro counter allows multiple version
bumps per day and resets for each new date.

Version comparison splits on `.`, compares the first three segments as
zero-padded strings, and the fourth as a number. This is implemented as the
`CalVer` value object in `src/domain/models/calver.ts`.

Models must support data written by all earlier versions, but not later
versions.

## Migration

A model can migrate its definitions from one version to the next using **upgrade
functions**. Each model declares an ordered list of `VersionUpgrade` entries,
one per version transition. When a definition's `typeVersion` is behind the
model's current `version`, the upgrade chain runs all applicable upgrades in
order, transforming global arguments at each step.

Upgrades are **lazy** — they run at method execution time in
`executeWorkflow()`, not at load time. The upgraded definition is persisted so
the upgrade only runs once.

### Upgrade Rules

- Upgrades must be ordered chronologically by `toVersion`
- The last upgrade's `toVersion` must equal the model's current `version`
- Upgrade functions are pure global argument transforms (old args → new args)
- Upgrades are forward-only; there is no downgrade path

### Example

A model starts at version `"2025.01.15.1"` with just a `message` global
argument. On `"2025.06.01.1"`, a `priority` field is added with a default. On
`"2026.02.09.1"`, the `message` field is renamed to `content`:

```typescript
import { z } from "zod";

export const model = {
  type: "acme/notifier",
  version: "2026.02.09.1",
  globalArguments: z.object({
    content: z.string().min(1),
    priority: z.enum(["low", "medium", "high"]),
  }),
  upgrades: [
    {
      toVersion: "2025.06.01.1",
      description: "Add priority field with default 'medium'",
      upgradeGlobalArguments: (old) => ({ ...old, priority: "medium" }),
    },
    {
      toVersion: "2026.02.09.1",
      description: "Rename 'message' to 'content'",
      upgradeGlobalArguments: (old) => {
        const { message, ...rest } = old;
        return { ...rest, content: message };
      },
    },
  ],
  methods: {
    send: {
      description: "Send a notification",
      arguments: z.object({}),
      execute: async (args, context) => {
        const globalArgs = context.globalArgs;
        const handle = await context.writeResource("result", "result", {
          sent: true,
          content: globalArgs.content,
          priority: globalArgs.priority,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

If a definition was created at `"2025.01.15.1"` with `{ message: "hello" }`, and
the model is now at `"2026.02.09.1"`, running a method will:

1. Apply upgrade to `"2025.06.01.1"`: `{ message: "hello", priority: "medium" }`
2. Apply upgrade to `"2026.02.09.1"`: `{ content: "hello", priority: "medium" }`
3. Persist the definition with `typeVersion: "2026.02.09.1"` and new global
   arguments
4. Execute the method with the merged arguments (global + per-method)

### Backwards Compatibility

Existing definitions on disk with numeric `typeVersion` (e.g., `typeVersion: 1`)
are automatically coerced to `undefined` by the `DefinitionSchema`, meaning
"pre-CalVer, needs upgrade from earliest version". They will be upgraded on
first method execution and persisted with the new CalVer `typeVersion`.

## Definitions

Definitions are specified as YAML files that live in the `/.swamp/definitions/`
directory of a repository, underneath the normalized type as a directory. The
file name is `${id}.yaml`. For example,
`.swamp/definitions/aws/ec2/vpc/fc7fd41e-ae16-4b31-b57a-86de716e3ece.yaml`.

The valid shape of a definition is specified with a Zod 4 schema as part of the
type.

Each definition has the following core properties:

- id: the models unique id
- name: a unique human readable name
- tags: string based key value pairs
- globalArguments: domain specific data shared across all methods (for example,
  the specific properties of a VPC from above).

### Input

A definition file can also specify custom inputs as JsonSchema serialized to
yaml. By default, every definition has optional inputs that map to the full set
of defined global arguments of the definition. If a type specifies that a
particular global argument is required, but it is not present in the static
definition, then it is a required input. If it is present in the definition,
then it will be optional (and can be over-ridden by an input.)

Custom input values can be accessed through CEL expressions.

## Instance

A model is instantiated by feeding its definition to the models constructor. The
models definition is hashed to provide an instantiation id. From the
instantiation id and a record of the definition, a model can always be
re-instantiated.

We call this an instance of a model.

## Methods

Methods can be called on instantiated models. Each method declares a required
`arguments` Zod schema for its per-method arguments. At execution time, the
method's `execute` function receives the merged arguments (global arguments from
the definition combined with per-method arguments) as its first parameter, and a
`MethodContext` as its second. The `MethodContext` includes `globalArgs`,
`definition` metadata (id, name, version, tags), `methodName`, and an optional
`redactor` (`SecretRedactor`) for stripping vault secrets from output.

Methods can write data, which is tracked by the method invocation and the
definition required to re-instantiate the object.

Each method invocation records its status in an output, which records any data
that was written in the invocation, status, and information about how it was
called.

Methods can also instantiate a model, from either an existing definition by name
or by supplying the definiton directly, then can invoke methods on those models.

## Data

Models produce two kinds of output data: **resources** and **files**.

### Resources

Resources are structured data with a Zod schema. They represent external
resource state, API responses, or any structured output. Resources are declared
in the model's `resources` field and written with `context.writeResource()`.

Resources are auto-tagged with `type: "resource"`.

### Files

Files are raw content with a content type (MIME type). They represent file
artifacts, logs, or any binary/text output. Files are declared in the model's
`files` field and written with `context.createFileWriter()`. Files can optionally
be marked as `streaming: true` for line-oriented output (replacing the old
dedicated log type).

Files are auto-tagged with `type: "file"`.

### Common Properties

Both resources and files share these properties:

- A unique name (the spec name, declared in `resources` or `files`)
- A unique id for the data
- The full definition of the model that wrote the data, so we can re-instantiate
  a model to operate on the data
- A lifetime, which defines how long the data should persist. Lifetimes can be
  expressed as a duration string (1h, 5m, 10d, 1mo, 10y). A lifetime of
  "ephemeral" means the data will only be stored for the duration of a method
  invocation or workflow execution. A lifetime of "infinite" will store the data
  forever. There are two special lifetimes, which are:
  - Job: the data persists only while the job that create it exists/is running
  - Workflow: The data persists until the workflow that created it exists/is
    running
- A garbage collection setting, which defines how many versions should be
  stored. This has the same values as lifetime, but can also accept a raw
  integer that specifies a specific number.
- A set of tags, which are used to mark data for human indexing and retrieval
  later.

Data is immutable. Each write to the same spec name creates a new version of
the data. The latest version can always be referred to as "latest". When used in
a CEL expression, "latest" is implied. Old versions can only be retrieved by a
CEL function. Versions will be auto-incrementing integers, starting at 1.

Data can only be written by a model instantiated from the same definition that
originally wrote the data. This is called the _owner_ of the data.

The raw data will be written to
`.swamp/data/{normalized-type}/{model-id}/{data-name}/{version}/raw`.

The metadata will be written to
`.swamp/data/{normalized-type}/{model-id}/{data-name}/{version}/metadata.yaml`.

There will be a symlink to the latest version at
`.swamp/data/{normalized-type}/{model-id}/{data-name}/latest/`.

## Data Output API

Methods write data during execution using two APIs on the method context:
`writeResource()` for structured resources and `createFileWriter()` for file
artifacts. Data is written directly to disk and the method returns lightweight
`DataHandle` references.

### Writing Resources

Use `context.writeResource(specName, name, data, overrides?)` to write structured
resource data. Returns a `Promise<DataHandle>`.

```typescript
execute: async (args, context) => {
  const handle = await context.writeResource("result", "result", {
    result: "processed value",
  });
  return { dataHandles: [handle] };
};
```

### Writing Files

Use `context.createFileWriter(specName, name, overrides?)` to get a `DataWriter` for
file output.

```typescript
execute: async (args, context) => {
  const writer = context.createFileWriter("execution-log", "execution-log");
  const handle = await writer.writeText("Step 1 completed\nStep 2 completed\n");
  return { dataHandles: [handle] };
};
```

### Writer Methods (for `createFileWriter`)

| Method                      | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `writeAll(content)`         | Write complete binary content (`Uint8Array`)     |
| `writeText(text)`           | Write text content (encoded as UTF-8)            |
| `writeLine(line)`           | Append a single line (for streaming/incremental) |
| `writeStream(stream, opts)` | Pipe a `ReadableStream<Uint8Array>`              |
| `getFilePath()`             | Get the file path for direct I/O                 |
| `finalize()`                | Finalize after using `writeLine`/`getFilePath`   |

### DataHandle

Lightweight reference to data already persisted:

| Field      | Description                              |
| ---------- | ---------------------------------------- |
| `name`     | Data artifact name                       |
| `specName` | The spec name from `resources` or `files` |
| `kind`     | `"resource"` or `"file"`                 |
| `dataId`   | Unique ID for this data                  |
| `version`  | Version number of this write             |
| `size`     | Size of the written content in bytes     |
| `tags`     | Tags from the writer options             |
| `metadata` | Full metadata for the data artifact      |

## Output

Each method invocation produces an output record, which gets tracked in the
`/.swamp/outputs/` directory of a repository (which should not be tracked in
git). The output record should track the state of the method execution, and the
list of artifacts produced by the method. It should track state as the method
executes. It should be structured as
`/.swamp/outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml`.

## Logical Views

The RepoIndexService maintains a model-centric logical view at `/models/` that
provides human/agent-friendly exploration of models by name.

### Model View Structure

```
/models/{model-name}/
  definition.yaml                → symlink to /.swamp/definitions/{type}/{id}.yaml
  {data-tag-key}/{data-tag-value}/  → symlink to /.swamp/data for the data as tagged
  outputs/
    {method}/                    → symlinks to /.swamp/outputs/{type}/{method}/{id}-*.yaml
```

This structure allows exploring all artifacts for a model in one place, using
the model's human-readable name rather than UUIDs or type-based paths.

### Domain Events

The ModelRepository emits domain events when model data changes:

- `ModelCreated` - Emitted when a new model definition is created via
  `model create`
- `ModelUpdated` - Emitted when a model definition or data is modified
- `ModelDeleted` - Emitted when a model is deleted

The RepoIndexService subscribes to these events and updates the logical views
accordingly, ensuring the `/models/` view stays synchronized with the data
directory.

## CLI Commands

### model type describe <type>

This command describes the model as a markdown document, will all of its
details, using code blocks as neccessary. it should syntax highlight the
markdown.

when specifying json, it should have the same content.

### model type search <string>

When run interactively, it should show a text box that says "type to search",
and then use the npm:fzf package to search the list of available types (by
either normalized type or actual type name). Then the user can use the arrow
keys to select the type they want, and the result will be the same as type
describe.

When run non-interactively, it should produce a json output that has the list.

### model create <type> <name>

Creates a new instance of a type with the given unique name. Type should accept
either the domain specific type or the normalized type. It should return the id
and path to the model that is created.

### model search <string>

When run interactively, it should show a text box that says "type to search",
and then use the npm:fzf package to search the list of available models (by
either normalized type or actual type name). Then the user can use the arrow
keys to select the type they want, and the result will be the same as type
describe.

When run non-interactively, it should produce a json output that has the list.

### model get <model_id_or_name>

Shows the entire details of the model. It should not include the type schema or
the methods.

when specifying json, it should have the same content.

### model validate <model_id_or_name>

Runs the models zod validations for the models inputs and resources. Run them in
parallel and print the output as it comes.

### model edit [model_id_or_name]

Opens the model input file in the user's preferred editor. Use `--resource` to
edit the resource file instead.

If no model is specified interactively, shows a search interface.

Editor selection: Uses $EDITOR if set, otherwise falls back to: vscode, zed,
nvim, vim, nano, emacs.

### model method run <model_id_or_name> <method_name>

Runs a method for the given model.
