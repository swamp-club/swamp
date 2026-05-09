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
      upgradeAttributes: (old) => ({ ...old, priority: "medium" }),
    },
    {
      toVersion: "2026.02.09.1",
      description: "Rename 'message' to 'content'",
      upgradeAttributes: (old) => {
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

There are two ways to create a definition:

### Direct Instantiation (`model create`)

Use this when you want to manage values in the definition file. Global arguments
are baked into the YAML, edited with `model edit`, and version-controlled in
git. Good for: static configuration that rarely changes, definitions that use CEL
expressions in global arguments, definitions shared across multiple workflow
steps.

These definitions live in the top-level `models/` directory of a repository,
underneath the normalized type as a directory. The file name is `${id}.yaml`.
For example,
`models/aws/ec2/vpc/fc7fd41e-ae16-4b31-b57a-86de716e3ece.yaml`.

### Direct Type Execution (recommended starting point)

Use this when everything comes from `--input` at runtime. The definition is
auto-created as a byproduct, not as a deliberate configuration act. Good for:
scripts, CI pipelines, one-shot CLI invocations, and workflow steps where all
values are dynamic.

**CLI syntax:**

```sh
swamp model @swamp/aws/ec2/vpc method run create my-vpc \
  --input region=us-east-1 --input cidr=10.0.0.0/16
```

**First run:** The definition `my-vpc` doesn't exist yet. Swamp auto-creates it
with type `@swamp/aws/ec2/vpc` and executes `create`. The `--input` values are
automatically routed between global arguments and method arguments using the
type's schemas (method arguments take precedence on ambiguous keys).

**Subsequent runs:** Finds `my-vpc`, verifies its type matches
`@swamp/aws/ec2/vpc` (safety check), and runs. The same command is idempotent.

**Storage:** Auto-created definitions live in `.swamp/auto-definitions/` (not
`models/`). They are local runtime state, not git-tracked, and do not appear in
`swamp model search` results. They are findable by name for `model get`,
`model method run`, and workflow references.

### Choosing Between the Two

| Question                                        | Direct Instantiation | Direct Type Execution |
| ----------------------------------------------- | -------------------- | --------------------- |
| Do you manage values in the definition file?    | Yes                  | No                    |
| Are values passed at runtime via `--input`?     | Sometimes            | Always                |
| Is the definition git-tracked?                  | Yes                  | No                    |
| Visible in `model search`?                      | Yes                  | No                    |
| Stored in                                       | `models/`            | `.swamp/auto-definitions/` |

### Definition Properties

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

## Pre-flight Checks

Pre-flight checks are optional guards that run automatically before any
_mutating_ method invocation. Mutating methods are those that change real
resource state: `create`, `update`, `delete`, and `action`. Read-only methods
(`sync`, `get`, etc.) do not trigger checks.

Checks give models a way to enforce invariants — policy constraints, dependency
readiness, quota availability — before execution begins, avoiding
half-completed operations.

### CheckDefinition

Each check is declared as a named entry in the model's optional `checks` field
(`checks?: Record<string, CheckDefinition>`):

```typescript
interface CheckDefinition {
  description: string;
  labels?: string[];
  appliesTo?: string[];   // method names; if omitted, applies to all mutating methods
  execute: (context: MethodContext) => Promise<CheckResult>;
}

interface CheckResult {
  pass: boolean;
  errors?: string[];
}
```

The `execute` function receives the same `MethodContext` as a method's execute
function, with one restriction: `writeResource` and `createFileWriter` are **not
available**. Checks inspect state only — they do not produce data output.

### isMutatingKind

The `isMutatingKind(methodName)` helper determines whether a method name is
considered mutating. It returns `true` for `create`, `update`, `delete`, and
`action`. This is used internally to decide whether to run checks.

### Labels and appliesTo

**Labels** categorize checks for selective skipping. Common conventions:

- `policy` — business rules and constraints (value validation, allowed values)
- `live` — checks that make live API calls (quota, existence checks)
- `dependency` — cross-model dependency validation (required upstream state)

**appliesTo** limits a check to specific methods. If omitted, the check runs
before all mutating methods. Use this to scope expensive or irrelevant checks:

```typescript
// Only validate quota before create, not before update or delete
appliesTo: ["create"],
```

### Skip Options

Users can bypass checks at runtime using CLI flags on `model method run`:

| Flag                         | Behavior                                   |
| ---------------------------- | ------------------------------------------ |
| `--skip-checks`              | Skip all pre-flight checks                 |
| `--skip-check <name>`        | Skip a specific check by name (repeatable) |
| `--skip-check-label <label>` | Skip all checks with a label (repeatable)  |

### Three Common Patterns

1. **Value/policy validation** — inspect `context.globalArgs` for invalid or
   disallowed values. No I/O. Always fast.

2. **Cross-model validation** — use `context.dataRepository` to read stored
   state from another model instance and verify a dependency exists or is in
   the right state.

3. **Live API checks** — call an external API to verify quota, existence, or
   reachability. Label these `live` so users can skip them in offline
   environments.

### Extension Checks

Extensions can add checks to existing model types via the optional third
parameter of `modelRegistry.extend()`:

```typescript
modelRegistry.extend("aws/ec2/vpc", {}, {
  "no-cidr-overlap": {
    description: "Ensure CIDR does not overlap",
    labels: ["policy"],
    execute: async (context) => { return { pass: true }; },
  },
});
```

Check name conflicts with checks already defined on the target type throw an
error at registration time. Extension checks follow the same `CheckDefinition`
interface and participate in all check selection mechanisms.

### Definition-Level Check Selection

Definition authors can control which checks run via a `checks` field in the
YAML definition:

```yaml
checks:
  require:
    - no-cidr-overlap
  skip:
    - slow-api-check
```

- **`require`** — checks listed here are immune to `--skip-checks`,
  `--skip-check <name>`, and `--skip-check-label <label>` CLI flags. They still
  respect `appliesTo` method scoping.
- **`skip`** — checks listed here are always skipped. `skip` wins over `require`
  if the same check appears in both.
- Validation (`model validate`) warns on require/skip overlap and errors if a
  referenced check does not exist on the model type.

### model validate Integration

`swamp model validate` runs checks as part of the validation pipeline. It honors
definition-level `skip` lists in addition to CLI flags. Two flags control check
execution:

- `--label <label>` — only run checks matching this label
- `--method <method>` — simulate validation for a specific method context

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

The raw data will be written to the datastore at
`data/{normalized-type}/{model-id}/{data-name}/{version}/raw` (default path:
`.swamp/data/{normalized-type}/{model-id}/{data-name}/{version}/raw`).

The metadata will be written to the datastore at
`data/{normalized-type}/{model-id}/{data-name}/{version}/metadata.yaml`.

There will be a symlink to the latest version at
`data/{normalized-type}/{model-id}/{data-name}/latest/`.

See [./datastores.md] for how the datastore path is resolved.

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

| Field      | Description                               |
| ---------- | ----------------------------------------- |
| `name`     | Data artifact name                        |
| `specName` | The spec name from `resources` or `files` |
| `kind`     | `"resource"` or `"file"`                  |
| `dataId`   | Unique ID for this data                   |
| `version`  | Version number of this write              |
| `size`     | Size of the written content in bytes      |
| `tags`     | Tags from the writer options              |
| `metadata` | Full metadata for the data artifact       |

## Output

Each method invocation produces an output record, which gets tracked in the
datastore `outputs/` directory (default `.swamp/outputs/`, not tracked in git).
The output record should track the state of the method execution, and the list
of artifacts produced by the method. It should track state as the method
executes. It should be structured as
`outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml`.

## Domain Events

The ModelRepository emits domain events when model data changes:

- `ModelCreated` - Emitted when a new model definition is created via
  `model create`
- `ModelUpdated` - Emitted when a model definition or data is modified
- `ModelDeleted` - Emitted when a model is deleted

The RepoIndexService subscribes to these events (currently a noop
implementation). See [./repo.md] for details on domain events.
