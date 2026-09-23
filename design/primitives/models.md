---
audience: maintainer, extension-author
last-verified: 2026-09-07 @ 58652907
---

# Models

A model in swamp is defined by a _type_. A model is instantiated by creating a
_definition_, whose global arguments are set statically or dynamically through
_inputs_. An instantiated _model_ is used by calling its _methods_, which
_output_ their results and can store _resources_ and _files_. Each method
declares its own _arguments_ schema and, at execution time, receives the global
and per-method arguments merged.

Resources are structured data with a schema; files are raw content with a
content type. Both are immutable, have a _lifetime_, can be _tagged_ with
capabilities, and store the _definition_ that created them, so the model can be
instantiated from the data it produces. Only a model instantiated with the same
definition as the original data can write that data again.

## Type

Every model has a unique _type_, named after the thing it models. For example, a
model that manages AWS VPCs through the Cloud Control API is named
'AWS::EC2::VPC', because that is the Cloud Control API's name for it. Types
should map semantically to the domain.

A type must start with a domain identifier. For example:

- AWS: AWS::EC2::VPC, AWS::Budget::Budgets
- Docker CLI: docker run, docker pull
- Azure: Microsoft.Resources/resourceGroup

Each type also has a normalized form that maps special characters to
directories, such as 'aws/ec2/vpc', 'docker/run' or
'microsoft/resources/resourceGroup'.

## ID

Each model instance has a unique uuidv4 ID.

## Version

Each model has a **CalVer** version, `YYYY.MM.DD.MICRO` (e.g. `"2025.01.15.1"`,
`"2025.06.01.3"`). The micro counter allows several bumps per day and resets
each new date.

Comparison splits on `.`, compares the first three segments as zero-padded
strings and the fourth as a number. This is the `CalVer` value object in
`src/domain/models/calver.ts`.

Models must support data written by all earlier versions, but not by later
ones.

## Migration

**Upgrade functions** migrate a model's definitions from one version to the
next. Each model declares an ordered list of `VersionUpgrade` entries, one per
version transition. When a definition's `typeVersion` is behind the model's
current `version`, the chain runs every applicable upgrade in order,
transforming global arguments at each step.

Upgrades are lazy. They run when a method executes, not when the definition
loads.
`DefaultMethodExecutionService.executeWorkflow()`
(`src/domain/models/method_execution_service.ts`) runs them through
`DefinitionUpgradeService` (`src/domain/models/definition_upgrade_service.ts`).
The upgraded definition is saved, so each upgrade runs only once.

### Who May Advance `typeVersion`

`typeVersion` records the model type version a definition's global arguments
were written or migrated for. Only two things may set it:

1. **Creation**: `model create`, direct type execution, and the internal grant
   and server-token definition writers set it to the registered model's version.
2. **`DefinitionUpgradeService`**, when it migrates the arguments.

Persistence must never set it. `YamlDefinitionRepository.save()` used to
overwrite `typeVersion` with the registered model's version on every write. That
marked a stale instance as current without migrating its arguments. The upgrade
service stops once `typeVersion` is at or above the model version, so no later
upgrade chain could ever migrate that instance (swamp-club#900).

An architecture fitness test pins the rule that every `Definition.create` call
site supplies the field (`integration/definition_type_version_rules_test.ts`).
A behavioural test would not catch a regression, because the creation paths that
relied on the old behaviour are for model types with no upgrade chain.

### Staleness

`resolveStaleness` compares a definition's recorded `typeVersion` with the
registered model's version and upgrade chain
(`src/domain/definitions/definition_staleness.ts`). It returns one of four
states:

| State        | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `current`    | Written or migrated for this model version.                                     |
| `upgradable` | Behind, and the upgrade chain covers the gap. The next method run migrates it.  |
| `stranded`   | Behind, and no upgrade covers the gap. The extension must ship a `VersionUpgrade`. |
| `unknown`    | No `typeVersion` recorded: a legacy pre-CalVer definition.                      |

`model get` reports `typeVersion`, `currentTypeVersion` and `staleness` in both
output modes. A method run warns once when an instance is `stranded`. There is
no warning for `unknown`, because it is not evidence of staleness and would fire
on every run.

### Upgrade Rules

- Upgrades must be ordered chronologically by `toVersion`
- The last upgrade's `toVersion` must equal the model's current `version`
- Upgrade functions are pure global argument transforms (old args → new args)
- Upgrades are forward-only; there is no downgrade path

### Example

A model starts at `"2025.01.15.1"` with one `message` global argument.
`"2025.06.01.1"` adds a `priority` field with a default. `"2026.02.09.1"`
renames `message` to `content`:

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

If a definition was created at `"2025.01.15.1"` with `{ message: "hello" }` and
the model is now at `"2026.02.09.1"`, running a method will:

1. Apply upgrade to `"2025.06.01.1"`: `{ message: "hello", priority: "medium" }`
2. Apply upgrade to `"2026.02.09.1"`: `{ content: "hello", priority: "medium" }`
3. Persist the definition with `typeVersion: "2026.02.09.1"` and new global
   arguments
4. Execute the method with the merged arguments (global + per-method)

### Backwards Compatibility

Definitions on disk with a numeric `typeVersion` (e.g. `typeVersion: 1`) are
coerced to `undefined` by the `DefinitionSchema` (`z.preprocess` in
`src/domain/definitions/definition.ts`). `undefined` stands for "pre-CalVer,
needs upgrade from earliest version". They are upgraded on first method
execution and saved with the new CalVer `typeVersion`.

So an absent `typeVersion` marks a legacy definition, and persistence must not
fill it in. Absence cannot tell a legacy definition from a hand-written one
whose arguments already have the current shape. Running the full chain on the
second kind would corrupt it. That open question is tracked in swamp-club#2412.

## Definitions

There are two ways to create a definition:

### Direct Instantiation (`model create`)

Use this to manage values in the definition file. Global arguments live in the
YAML, are edited with `model edit`, and are version-controlled in git. Good for
static configuration that rarely changes, definitions with CEL expressions in
global arguments, and definitions shared across several workflow steps.

These definitions live in the repository's top-level `models/` directory, under
a directory for the normalized type. The file is `<name>.yaml` when the name is
filename-safe, for example `models/aws/ec2/vpc/my-vpc.yaml`. Other names fall
back to the legacy `${id}.yaml` form (`resolveWritePath` in
`src/infrastructure/persistence/yaml_definition_repository.ts`).

### Direct Type Execution (recommended starting point)

Use this when every value comes from `--input` at runtime. The definition is
created automatically as a side effect. Good for scripts, CI pipelines,
one-shot CLI calls, and workflow steps where all values are dynamic.

**CLI syntax:**

```sh
swamp model @swamp/aws/ec2/vpc method run create my-vpc \
  --input region=us-east-1 --input cidr=10.0.0.0/16
```

**First run:** `my-vpc` does not exist yet. Swamp creates it with type
`@swamp/aws/ec2/vpc` and runs `create`. The type's schemas route the `--input`
values to global or method arguments; method arguments win on ambiguous keys.

**Subsequent runs:** Swamp finds `my-vpc`, checks that its type matches
`@swamp/aws/ec2/vpc` (a safety check), and runs. If the routed global arguments
differ from the stored definition, the definition is updated and saved. This
way parameterized workflows that vary inputs per run always use current values.

**Storage:** Auto-created definitions live in `.swamp/auto-definitions/`, not
`models/`. They give model data an ownership boundary without a hand-written
definition file. They are local runtime state, are not tracked in git, and do
not appear in `swamp model search` results. `model get`, `model method run`
and workflow references can find them by name. `model get` shows
`Auto-created: yes` for them.

### Choosing Between the Two

| Question                                        | Direct Instantiation | Direct Type Execution |
| ----------------------------------------------- | -------------------- | --------------------- |
| Do you manage values in the definition file?    | Yes                  | No                    |
| Are values passed at runtime via `--input`?     | Sometimes            | Always                |
| Is the definition git-tracked?                  | Yes                  | No                    |
| Visible in `model search`?                      | Yes                  | No                    |
| Stored in                                       | `models/`            | `.swamp/auto-definitions/` |

### Definition Properties

A Zod 4 schema in the type specifies a definition's valid shape. Core
properties:

- id: the model's unique id
- name: a unique human-readable name
- tags: string key-value pairs
- globalArguments: domain-specific data shared by all methods (for example, the
  VPC properties above)

### Input

A definition file can also declare custom inputs as JsonSchema serialized to
YAML. By default, every definition has optional inputs matching all of its
global arguments. A global argument the type marks required becomes a required
input when the static definition omits it. When the definition sets it, the
input is optional and can override it.

CEL expressions can read custom input values.

## Instance

A model is instantiated by passing its definition to the model's constructor.
Hashing the definition gives an instantiation id. With that id and a record of
the definition, the model can always be re-instantiated. This is an instance of
a model.

## Methods

Methods are called on instantiated models. Each method declares a required
`arguments` Zod schema for its per-method arguments. At execution time, its
`execute` function receives the merged arguments (the definition's global
arguments plus per-method arguments) first and a `MethodContext` second.
`MethodContext` includes `globalArgs`, `definition` metadata (id, name, version,
tags), `methodName`, and an optional `redactor` (`SecretRedactor`) that strips
vault secrets from output.

If the `arguments` schema is a `z.record()` rather than `z.object()`, global
arguments are not merged in; the method gets only per-method arguments. This
keeps global argument fields out of the open-ended record. Global arguments stay
available through `context.globalArgs`.

Data a method writes is tracked with the method invocation and the definition
needed to re-instantiate the object.

Each invocation records an output: the data written, the status, and how the
method was called.

Methods can also instantiate a model, from an existing definition by name or a
definition passed directly, and invoke its methods. This uses
`context.runModel()`.

### Cross-Model Invocation (`context.runModel`)

`context.runModel(options)` lets a method invoke another model's method during
its own execution and use the result inline. Two calling conventions:

```typescript
// Call an existing definition by name
const result = await context.runModel({
  definition: "my-vpc",
  method: "read",
});

// Direct type execution (auto-creates definition)
const result = await context.runModel({
  modelType: "aws/ec2/vpc",
  name: "my-new-vpc",
  method: "create",
  arguments: { cidrBlock: "10.0.0.0/16" },
});
```

Returns a discriminated result:

- `{ ok: true, resources: DataHandle[] }` on success
- `{ ok: false, error: { message, stack? } }` on failure

**Argument routing:** The target type's Zod schemas route the `arguments` object
between globalArguments and method arguments, as with CLI `--input`. Method
arguments win on ambiguous keys. Unknown keys return `{ ok: false }`. For direct
type execution, only global-arg values are saved in the auto-created
definition; method-arg values apply only to that invocation.

**Data ownership:** When model X calls model Y, Y's writes belong to Y's
definition, not X's. This holds whether Y runs standalone, from a workflow or
inside X.

**Failure semantics:** Y's failure reaches X as `{ ok: false }`, and X decides
how to handle it. Data X and Y already saved stays.

**Depth and cycle limits:** At most 10 levels deep, matching workflow nesting.
Cycles are detected through an ancestor chain of `(modelType, method)` pairs.
At most 100 total `runModel` calls per top-level execution, matching follow-up
action limits.

**Vault isolation:** The caller's `VaultSecretBag` is not passed to the nested
model. Each nested execution resolves its own vault expressions.

**Runtime authorization:** Extension models must declare dependencies in
`manifest.yaml` to invoke models from other extensions. Built-in types and
user-authored models are unrestricted, and same-extension calls are always
allowed. Unauthorized calls return `{ ok: false }` with an actionable error
message.

**Remote execution:** `context.runModel()` is not available on remote workers.
Models that need it should run locally or use a workflow for orchestration.

**Output lineage:** Nested invocations produce `ModelOutput` records with
`triggeredBy: "model"`, a `parentOutputId` pointing to the caller's output, and
`callerExtension` for provenance tracking.

### Execution Identity

Every method execution records `bundleFingerprint` on `ExecutionProvenance`: the
SHA-256 source fingerprint of the extension bundle that produced the output.
Only core can provide this piece of execution identity. `definitionHash` and
`modelVersion` cover the definition content and type version, but neither
proves which code ran.

The field is optional. Old outputs without it still parse, and built-in model
types, which have no extension bundle, leave it undefined. A lifecycle consumer
can store the fingerprint with its evidence and compare it with the current
invocation to decide whether an interrupted run can safely resume.

### Workflow Gate Control (`context.approveWorkflowGate`, `context.rejectWorkflowGate`)

`context.approveWorkflowGate(options)` and `context.rejectWorkflowGate(options)`
let a method approve or reject a suspended workflow's `manual_approval` gate
without spawning a child `swamp` process. This supports webhook-driven
approvals, scheduler-driven gates and other in-process automation.

```typescript
// Approve a suspended gate
const result = await context.approveWorkflowGate({
  workflowIdOrName: "deploy-pipeline",
  stepName: "prod-approval",
  reason: "Approved via Linear webhook",
});

// Reject a gate
const result = await context.rejectWorkflowGate({
  workflowIdOrName: "deploy-pipeline",
  stepName: "prod-approval",
  reason: "Reviewer rejected",
});
```

Returns a discriminated result:

- `{ ok: true, runId, workflowName, stepName, approved, decidedBy }` on success
- `{ ok: false, error: { message } }` on failure

**Approve** marks the step succeeded and saves the run. The workflow stays
suspended until resumed with `swamp workflow resume`.

**Reject** marks the step failed, fails the job and completes the run as failed.
No resume is needed.

**`decidedBy` is auto-populated** from the calling model's definition name and
method name (e.g. `model:webhook-handler/on_comment`). Extensions cannot
override it; this is enforced for audit integrity.

**Remote execution:** Not available on remote workers. Returns `{ ok: false }`
with an actionable error message.

## Pre-flight Checks

Pre-flight checks are optional guards that run automatically before any
_mutating_ method invocation. A method's kind is its `kind` field or, if
omitted, is inferred from its name by `inferMethodKind()`
(`src/domain/models/model.ts`):

- `create`
- `get`/`read`/`describe`/`show` → `read`
- `update`/`patch` → `update`
- `delete`/`destroy`/`remove` → `delete`
- `list`/`search`/`find` → `list`

The `read` and `list` kinds do not trigger checks; every other kind does. Names
not in this list (e.g. `sync`) infer no kind, so they default to mutating. Set
`kind: "read"` or `kind: "list"` to suppress checks for them.

Checks let models enforce invariants (policy constraints, dependency readiness,
quota availability) before execution begins, which avoids half-completed
operations.

### CheckDefinition

Each check is a named entry in the model's optional `checks` field
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

`execute` receives the same `MethodContext` as a method's execute function,
with two differences:

- `writeResource` and `createFileWriter` are not available. Checks only
  inspect state; they produce no data output.
- `unresolvedMethodArgs` is populated with the method's arguments merged
  over filtered global arguments. Global args containing unresolved `${{ }}`
  expressions are excluded. This lets per-method checks confirm that required
  arguments are present before execution begins.

```typescript
// Example: validate a method argument in a pre-flight check
checks: {
  "spec-required": {
    description: "Forward requires a spec argument",
    appliesTo: ["forward"],
    execute: async (context) => {
      if (!context.unresolvedMethodArgs?.spec) {
        return { pass: false, errors: ["forward requires a `spec`"] };
      }
      return { pass: true };
    },
  },
},
```

### isMutatingKind

The `isMutatingKind(kind: MethodKind | undefined)` helper
(`src/domain/models/model.ts:733`) takes the method's kind, not its name. It
returns `true` for everything except `"read"` and `"list"`, including
`undefined` (unrecognized names). It is used internally to decide whether to
run checks.

### Labels and appliesTo

**Labels** group checks for selective skipping. Common conventions:

- `policy`: business rules and constraints (value validation, allowed values)
- `live`: checks that make live API calls (quota, existence checks)
- `dependency`: cross-model dependency validation (required upstream state)

**appliesTo** limits a check to specific methods. Without it, the check runs
before all mutating methods. Use it to scope expensive or irrelevant checks:

```typescript
// Only validate quota before create, not before update or delete
appliesTo: ["create"],
```

### Skip Options

Users can bypass checks at runtime with these `model method run` flags:

| Flag                         | Behavior                                   |
| ---------------------------- | ------------------------------------------ |
| `--skip-checks`              | Skip all pre-flight checks                 |
| `--skip-check <name>`        | Skip a specific check by name (repeatable) |
| `--skip-check-label <label>` | Skip all checks with a label (repeatable)  |

### Three Common Patterns

1. **Value/policy validation**: inspect `context.globalArgs` for invalid or
   disallowed values. No I/O, always fast.

2. **Cross-model validation**: read another model instance's stored state with
   `context.dataRepository.getContent` or `findAllForModel`, and verify that a
   dependency exists or is in the right state. Both accept the definition name
   or its UUID, because `buildMethodContext` wraps the repository so names
   resolve to IDs (`src/domain/models/method_context.ts`). Checks do not get
   `context.readModelData`, `context.queryData` or `context.runModel`. Only
   `InProcessExecutor` binds those, for method execution.

3. **Live API checks**: call an external API to verify quota, existence or
   reachability. Label these `live` so users can skip them offline.

### Extension Checks

Extensions can add checks to existing model types through the optional third
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

A check whose name conflicts with a check already on the target type throws an
error at registration. Extension checks use the same `CheckDefinition`
interface and take part in all check selection mechanisms.

### Definition-Level Check Selection

Definition authors can choose which checks run with a `checks` field in the
YAML definition:

```yaml
checks:
  require:
    - no-cidr-overlap
  skip:
    - slow-api-check
```

- **`require`**: these checks ignore the `--skip-checks`,
  `--skip-check <name>` and `--skip-check-label <label>` CLI flags. They still
  respect `appliesTo` method scoping.
- **`skip`**: these checks are always skipped. `skip` wins over `require` if a
  check appears in both.
- Validation (`model validate`) warns on require/skip overlap and errors if a
  referenced check does not exist on the model type.

### model validate Integration

`swamp model validate` runs checks as part of validation. It runs all checks
regardless of `appliesTo`, so validate surfaces the same errors method
execution would. It honors definition-level `skip` lists as well as CLI flags.
Two flags narrow which checks run:

- `--label <label>`: only checks with this label
- `--method <method>`: only checks that apply to this method (skips checks whose
  `appliesTo` excludes it)

## Data

Models produce two kinds of output data: **resources** and **files**.

### Resources

Resources are structured data with a Zod schema, such as external resource
state, API responses or any structured output. They are declared in the model's
`resources` field and written with `context.writeResource()`.

Resources are auto-tagged with `type: "resource"`.

### Files

Files are raw content with a content type (MIME type), such as file artifacts,
logs or any binary/text output. They are declared in the model's `files` field
and written with `context.createFileWriter()`. A file can be marked
`streaming: true` for line-oriented output, which replaces the old dedicated
log type.

Files are auto-tagged with `type: "file"`.

### Common Properties

Resources and files share these properties:

- A unique name (the spec name, declared in `resources` or `files`)
- A unique id for the data
- The full definition of the model that wrote the data, so a model can be
  re-instantiated to operate on it
- A lifetime: how long the data persists. It can be a duration string (1h, 5m,
  10d, 1mo, 10y). "ephemeral" stores the data only for the method invocation or
  workflow execution. "infinite" stores it forever. There are two special
  lifetimes:
  - Job: the data persists only while the job that created it exists/is running
  - Workflow: the data persists until the workflow that created it exists/is
    running
- A garbage collection setting: how many versions to store. It takes the same
  values as lifetime, or a raw integer for a specific number.
- A set of tags that mark data for human indexing and later retrieval.

Data is immutable. Each write to the same spec name creates a new version.
Versions are auto-incrementing integers starting at 1. The latest version can
always be referred to as "latest", and CEL expressions imply it. Old versions
can only be retrieved by a CEL function.

Only a model instantiated from the definition that first wrote the data can
write it again. That definition is the data's _owner_.

Datastore paths:

- Raw data: `data/{normalized-type}/{model-id}/{data-name}/{version}/raw`
  (default: `.swamp/data/{normalized-type}/{model-id}/{data-name}/{version}/raw`)
- Metadata:
  `data/{normalized-type}/{model-id}/{data-name}/{version}/metadata.yaml`
- Latest version: a plain text marker file at
  `data/{normalized-type}/{model-id}/{data-name}/latest` holding the version
  number (e.g. `2`)

See [datastores.md](../enablers/datastores.md) for how the datastore path is
resolved.

## Data Output API

Methods write data with two method-context APIs: `writeResource()` for
structured resources and `createFileWriter()` for file artifacts. Data goes
straight to disk, and the method returns lightweight `DataHandle` references.

### Writing Resources

`context.writeResource(specName, name, data, overrides?)` writes structured
resource data and returns a `Promise<DataHandle>`.

```typescript
execute: async (args, context) => {
  const handle = await context.writeResource("result", "result", {
    result: "processed value",
  });
  return { dataHandles: [handle] };
};
```

### Writing Files

`context.createFileWriter(specName, name, overrides?)` returns a `DataWriter`
for file output.

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
| `attributes` | Top-level resource attributes (resource kind only, optional) |

### Write Atomicity (rollbackOnFailure)

By default, `writeResource()` and `createFileWriter()` commit each write
immediately: the `latest` marker advances and `data.latest()` consumers see the
data. If a method fails midway, earlier writes persist.

A method opts into all-or-nothing writes by setting `rollbackOnFailure: true`
on its definition:

```typescript
methods: {
  readAll: {
    description: "Read all 96 wells",
    rollbackOnFailure: true,
    arguments: z.object({}),
    execute: async (args, ctx) => {
      for (const well of wells) {
        await ctx.writeResource("reading", well, await instrument.read(well));
      }
      return {};
    },
  },
}
```

With `rollbackOnFailure` true, writes use deferred-latest mode:

1. **During execution**: data is written to disk but the `latest` marker does
   not advance. The catalog row is written with `is_latest=0`. Concurrent
   readers calling `data.latest()` see the previous version, or nothing.
2. **On success**: all `latest` markers advance and catalog rows flip to
   `is_latest=1`. Data becomes visible atomically.
3. **On failure**: version directories and catalog rows are removed. No trace of
   the failed writes remains.

Because markers never advance during execution, deferred-latest has no TOCTOU
window and nothing to roll back on failure.

**When NOT to use**: methods that interact with external systems and write data
reflecting real-world state should leave this flag unset. Their writes may be
the most accurate picture of reality even if the method fails partway. Methods
that write then throw on purpose (e.g. a code-review model that writes results
then throws on verdict=FAIL) must also leave it unset.

## Output

Each method invocation produces an output record in the datastore `outputs/`
directory (default `.swamp/outputs/`, not tracked in git). The record should
track the method's execution state as it runs and the list of artifacts it
produced. Its path should be
`outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml`.

### Output Lifetime

By default, outputs persist until removed manually with `swamp run gc`. That
command uses the repository's `.swamp.yaml` `garbageCollection.outputs`
retention (30 days when unset); `--older-than` overrides it for one run. A
method can declare an `outputLifetime` as a retention ceiling: a duration string
like `"1d"` or `"7d"`, or `"infinite"` for the default behavior. The scoped
lifetimes `"ephemeral"`, `"job"` and `"workflow"` are not valid for outputs,
since outputs are not scoped to a process or workflow run.

`swamp run gc` uses `min(globalRetention, methodOutputLifetime)` as the cutoff
for each method's outputs. An operator can always tighten retention globally,
and the model author's declared ceiling is still respected.

High-traffic methods whose return value is consumed synchronously (e.g.
`swamp/server-token.redeem`) should declare a short lifetime (e.g. `"1d"`). This
keeps the outputs directory and the datastore index from growing without bound.

## Domain Events

The ModelRepository emits domain events when model data changes:

- `ModelCreated`: a new model definition is created via `model create`
- `ModelUpdated`: a model definition or data is modified
- `ModelDeleted`: a model is deleted

A `NoopRepoIndexService` is instantiated but not wired to the event bus, so no
handler currently receives these events. See [repo.md](../surfaces/repo.md) for
details on domain events.
