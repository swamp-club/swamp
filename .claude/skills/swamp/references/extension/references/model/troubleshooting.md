# Troubleshooting Extension Behaviors

## Table of Contents

- [Common Errors](#common-errors)
  - [Treating X as a helper module / behavior type missing](#treating-x-as-a-helper-module--behavior-type-missing)
  - [Module exports both model and behavior](#module-exports-both-model-and-behavior)
  - [Type defined in both extensions/models/ and extensions/behaviors/](#type-defined-in-both-extensionsmodels-and-extensionsbehaviors)
  - [Behavior missing from the registry catalog (uncatalogued-model)](#behavior-missing-from-the-registry-catalog-uncatalogued-model)
  - [Content uses collectives that don't match](#content-uses-collectives-that-dont-match)
  - [Unknown resource spec / Unknown file spec](#unknown-resource-spec-or-unknown-file-spec)
  - [Model type already registered](#model-type-already-registered)
  - [Uses a reserved collective](#uses-a-reserved-collective)
  - [Cannot extend unregistered model type](#cannot-extend-unregistered-model-type)
  - [Method already exists](#method-x-already-exists-on-model-type-y)
  - [Duplicate method name](#duplicate-method-name-x-within-extension-methods-array)
  - [No such key in CEL expressions](#no-such-key-specname-in-cel-expressions)
  - [Property not found in expression path validation](#property-not-found-in-expression-path-validation)
  - [Extension has formatting or lint issues](#extension-has-formatting-or-lint-issues)
  - [Syntax errors on load](#syntax-errors-on-load)
- [Configuration](#configuration)
- [Verification Commands](#verification-commands)

## Common Errors

### "Treating X as a helper module" / behavior type missing

At debug level (`-v`), the loader logs
`Treating "foo/lib/util.ts" as a helper module (no "model" export, so not a "model" entry point)`
for every file under `extensions/behaviors/` (or `extensions/models/`) without a
behavior or extension export. For helper files imported by a behavior this is
expected and harmless — leave them where they are.

If the file was meant to be a behavior, it needs a named export for either a
behavior or extension:

```typescript
// Wrong
const behavior = { ... };

// Correct — new behavior type
export const behavior = { ... };

// Correct — extend existing type
export const extension = { ... };
```

### "Module exports both 'model' and 'behavior'"

`export const behavior` and `export const model` are two spellings of one
export. A file may define only one of them; delete or rename the other.

### Type defined in both `extensions/models/` and `extensions/behaviors/`

`Type "<type>" (kind=model) is defined in both <file> and <file>` means the same
type is declared once in each directory. `extensions/behaviors/` is another
spelling of `extensions/models/`, so keep the type in one of them.

### Behavior missing from the registry catalog (`uncatalogued-model`)

The registry catalog reads a behavior's `type` and `version` as string literals
from a plain `export const behavior = { ... }` object (or
`export const model = { ... }`). A behavior that installs and runs but is
missing from `swamp extension search --content-type models`, or a push warning
`uncatalogued-model`, means one of them could not be read:

```typescript
// Wrong — version comes only from the factory
export const behavior = { ...definition, type: "@acme/thing" };

// Wrong — the annotation hides the object from the catalog
export const behavior: ModelDefinition = {
  type: "@acme/thing",
  version: "...",
};

// Correct — repeat both literals; check the shape with satisfies
export const behavior = {
  ...definition,
  type: "@acme/thing",
  version: "2026.09.25.1",
} satisfies ModelDefinition;
```

Republish after the fix; the new version is catalogued.

### "Content uses collectives that don't match"

Every type an extension registers must start with the extension's own
collective. Push checks the type each source registers when it is loaded, not
only the literal in its text, so a type held in a constant, an import or a
spread is checked too, and so is any `.ts` file under a kind directory (helper
files included) that exports a behavior. Fix the type the listed file registers,
or move the file to an extension in that collective.

- **Push** lists each offending `kind: type in file` under "Collective errors".
- **`unverified-collective` warning**: push could neither read the type from the
  text nor load the source (the warning names the import or top-level error).
  Fix that error, or write the type as a string literal.

### "Unknown resource spec" or "Unknown file spec"

When calling `writeResource(specName, data)` or `createFileWriter(specName)`,
the `specName` must match a key declared in the behavior's `resources` or
`files`. Declare specs on the behavior definition:

```typescript
export const behavior = {
  type: "@user/my-behavior",
  version: "2026.02.09.1",
  resources: {
    "result": {
      description: "Behavior output data",
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run the behavior",
      arguments: InputSchema,
      execute: async (
        _args: Record<string, never>,
        context: {
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => { ... },
    },
  },
};
```

### "Model type already registered"

Type name conflicts with a built-in or another user-defined behavior type. Use
unique collective names:

```typescript
// Avoid
type: "@user/echo"; // May conflict with other users

// Use
type: "@myorg/echo"; // Use your own collective
```

### "Uses a reserved collective"

Reserved collectives (`swamp`, `si`) are for built-in types only:

```typescript
// Wrong - reserved collective
type: "swamp/my-behavior";
type: "@swamp/my-behavior";
type: "si/auth";
type: "@si/auth";

// Correct - use any other collective
type: "@myorg/my-behavior";
type: "myorg/my-behavior";
type: "digitalocean/app-platform";
```

### "Cannot extend unregistered model type"

The extension targets a behavior type that isn't registered. Ensure the type
string matches exactly (e.g., `"command/shell"`, not `"shell"`). If extending a
user behavior, both files must be in the extensions directories swamp loads
(`extensions/behaviors/` or `extensions/models/`) — behaviors are loaded before
extensions automatically.

### "Method 'X' already exists on behavior type 'Y'"

The extension tries to add a method with the same name as an existing method.
Extensions can only add new methods, not override existing ones. Use a different
method name.

### "Duplicate method name 'X' within extension methods array"

The same method name appears in multiple elements of the `methods` array within
a single extension file. Each method name must be unique across all array
elements.

### "Duplicate data instance name"

This error occurs when two `writeResource` or `createFileWriter` calls within
the same method execution use the same instance name, even across different
specs. Instance names map to storage paths on disk — the path has no spec
component, so `writeResource("summary", "bixu", ...)` and
`writeResource("repo", "bixu", ...)` both write to the same `bixu/` directory,
and the second overwrites the first.

**Fix:** Use unique instance names across all specs within a method. Prefix with
the spec name or another distinguishing value:

```typescript
// Wrong — same instance name across specs
await context.writeResource("summary", user.name, summaryData);
await context.writeResource("repo", repo.name, repoData);
// Fails when user.name === repo.name (e.g., both are "bixu")

// Correct — prefix ensures uniqueness
await context.writeResource("summary", `summary-${user.name}`, summaryData);
await context.writeResource("repo", `repo-${repo.name}`, repoData);
```

### "No such key: `<specName>`" in CEL expressions

This occurs when a CEL expression like
`model.<m>.resource.<specName>.<instanceName>.attributes.X` can't find the
resource. Common causes:

**1. Instance name mismatch.** The `name` parameter (second argument) passed to
`writeResource` determines the instance name. If you wrote
`writeResource("vpc", "my-vpc", data)`, the CEL path is
`model.<m>.resource.vpc.my-vpc.attributes.X`. Using just
`model.<m>.resource.vpc` won't work — you need the full path including instance
name.

```typescript
// Writes to spec "vpc" with instance name "main"
await context.writeResource("vpc", "main", data);
// CEL: model.<name>.resource.vpc.main.attributes.X
```

**2. Resource spec name contains hyphens.** CEL interprets hyphens as
subtraction, so `model.<m>.resource.internet-gateway` is parsed as
`resource.internet` minus `gateway`. Use camelCase or single words for spec
names (e.g., `igw`, `routeTable`).

**3. Behavior has never been executed.** The `resource` key on `model.<name>` is
only populated if the behavior has produced data (a method was run that called
`writeResource`). If no data exists, `model.<name>` has `input` and `definition`
keys but no `resource` key. Run the create method or workflow first, or check
with `swamp data list <behavior-name>` to verify data exists.

### "Property not found" in expression path validation

The expression path validator checks that referenced attributes exist in the
resource's Zod schema. If you use `z.object({}).passthrough()`, the schema has
no declared properties and the validator can't resolve paths like
`attributes.VpcId`. Declare the properties you need to reference:

```typescript
// Wrong — validator can't resolve attributes.VpcId
schema: z.object({}).passthrough(),

// Correct — VpcId is declared, .passthrough() allows additional fields
schema: z.object({ VpcId: z.string() }).passthrough(),
```

### "Extension has formatting or lint issues"

When `swamp extension push` runs its quality checks and they fail, the push is
blocked:

```
Fix: Run `swamp extension fmt <manifest-path>` to auto-fix formatting and lint
issues, then retry the push.
```

If unfixable issues remain after running `fmt`, manually address the lint errors
shown in the output. Common causes include unused variables, missing return
types, or patterns that `deno lint --fix` cannot auto-correct.

You can also run `swamp extension fmt <manifest-path> --check` to preview issues
without modifying files.

### Syntax errors on load

Extension behaviors are loaded as JavaScript at runtime. Avoid TypeScript-only
syntax:

```typescript
// Wrong - non-null assertion (!) causes SyntaxError
const handle = await context.writeResource!("state", "main", data);

// Correct - call without !
const handle = await context.writeResource("state", "main", data);

// Wrong - type annotations cause syntax error
execute: async (args: { id: string }, context: any) => { ... }

// Correct
execute: async (args, _context) => { ... }
```

## Configuration

Models directory priority:

| Priority | Method               | Example                             |
| -------- | -------------------- | ----------------------------------- |
| 1        | Environment variable | `SWAMP_MODELS_DIR=./custom/path`    |
| 2        | Environment variable | `SWAMP_BEHAVIORS_DIR=./custom/path` |
| 3        | `.swamp.yaml` config | `modelsDir: "lib/models"`           |
| 4        | Default              | `extensions/models`                 |

`SWAMP_BEHAVIORS_DIR` is the behavior spelling of `SWAMP_MODELS_DIR`; setting
both to different directories is an error. While the default applies, swamp also
loads `extensions/behaviors/`, the behavior spelling of `extensions/models/`.
Setting either variable or `modelsDir` to any other directory turns that off.

**The table above is the historical default and still applies to every existing
manifest.** A manifest with no `paths` field — or with the explicit
`paths.base: typedDir` — uses this priority chain to find the configured models
directory. Only manifests that explicitly opt in with `paths.base: manifest`
skip the table entirely and resolve typed keys (`behaviors` or `models`,
`vaults`, `datastores`, `reports`, `include`) relative to the manifest's own
directory. The default is unchanged. See
[extension-publish references/publishing.md](../../../extension-publish/references/publishing.md#path-resolution--pathsbase)
for the canonical reference.

The models directory is appended to the **extensions root**: `--extensions-dir`
when given, else the repo dir, or the directory inferred from the manifest's
location when nothing resolves under the repo dir. A `Model file not found`,
`Behavior file not found`, `Workflow file not found` or
`Skill directory not found` error lists the paths it looked in and names the
fix: pass `--extensions-dir <dir>` naming the directory that _contains_
`extensions/behaviors/<entry>` or `extensions/models/<entry>` (not `extensions/`
itself), or add `paths.base: manifest`. `No manifest.yaml found in <dir>` means
the directory argument holds no manifest;
`Manifest file not found: <arg>
(looked in ...)` lists every base the relative
argument was tried against.

## Auto-Resolution Failures

Extensions from trusted collectives (the explicit `trustedCollectives` list in
`.swamp.yaml`; only `swamp` by default) auto-resolve on first use. Membership
collectives are not trusted automatically — run
`swamp extension trust add <collective>` first. If auto-resolution fails:

| Symptom                       | Cause                                      | Fix                                                                              |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| "no matching extension found" | Extension doesn't exist in registry        | `swamp extension search <query>` to find correct name                            |
| Network/timeout error         | Can't reach swamp.club                     | Check connectivity; manual: `swamp extension pull @name`                         |
| Type not auto-resolving       | Collective not trusted                     | `swamp extension trust list` to check, `swamp extension trust add <name>` to add |
| Silent "Unknown model type"   | Type uses non-`@` prefix or single segment | Use `@collective/name` format                                                    |
| Stale membership              | Collectives changed since last login       | Run `swamp auth whoami` to refresh cached collectives                            |

## Verification Commands

```bash
# Verify the behavior loads
swamp behavior type search --json

# Check the behavior schema
swamp behavior type describe @myorg/my-behavior --json

# Test the behavior
swamp behavior create @myorg/my-behavior test --global-arg fieldName="test" --json
swamp behavior run test methodName
```
