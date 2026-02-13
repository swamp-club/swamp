# Troubleshooting Extension Models

## Table of Contents

- [Common Errors](#common-errors)
  - [No 'model' or 'extension' export found](#no-model-or-extension-export-found)
  - [Unknown resource spec / Unknown file spec](#unknown-resource-spec-or-unknown-file-spec)
  - [Model type already registered](#model-type-already-registered)
  - [Model type must use '@' prefix](#model-type-must-use--prefix)
  - [Uses a reserved namespace](#uses-a-reserved-namespace)
  - [Cannot extend unregistered model type](#cannot-extend-unregistered-model-type)
  - [Method already exists](#method-x-already-exists-on-model-type-y)
  - [Duplicate method name](#duplicate-method-name-x-within-extension-methods-array)
  - [No such key in CEL expressions](#no-such-key-specname-in-cel-expressions)
  - [Property not found in expression path validation](#property-not-found-in-expression-path-validation)
  - [Syntax errors on load](#syntax-errors-on-load)
- [Configuration](#configuration)
- [Verification Commands](#verification-commands)

## Common Errors

### "No 'model' or 'extension' export found"

Must use a named export for either a model or extension:

```typescript
// Wrong
const model = { ... };

// Correct — new model type
export const model = { ... };

// Correct — extend existing type
export const extension = { ... };
```

### "Unknown resource spec" or "Unknown file spec"

When calling `writeResource(specName, data)` or `createFileWriter(specName)`,
the `specName` must match a key declared in the model's `resources` or `files`.
Declare specs on the model definition:

```typescript
export const model = {
  type: "@user/my-model",
  version: "2026.02.09.1",
  resources: {
    "result": {
      description: "Model output data",
      schema: z.object({ value: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    run: {
      description: "Run the model",
      arguments: InputSchema,
      execute: async (args, context) => { ... },
    },
  },
};
```

### "Model type already registered"

Type name conflicts with built-in or another user model. Use unique namespaced
names:

```typescript
// Avoid
type: "@user/echo"; // May conflict with other users

// Use
type: "@myorg/echo"; // Use your own namespace
```

### "Model type must use '@' prefix"

User-defined models must start with `@`:

```typescript
// Wrong - missing @ prefix
type: "mycompany/echo";

// Correct
type: "@mycompany/echo";
type: "@user/echo";
```

### "Uses a reserved namespace"

Reserved namespaces (`swamp`, `si`) are for built-in types only:

```typescript
// Wrong - reserved namespace
type: "swamp/my-model";
type: "@swamp/my-model";
type: "si/auth";
type: "@si/auth";

// Correct - use any other namespace
type: "@myorg/my-model";
type: "@user/my-model";
```

### "Cannot extend unregistered model type: ..."

The extension targets a model type that isn't registered. Ensure the type string
matches exactly (e.g., `"command/shell"`, not `"shell"`). If extending a user
model, both files must be in the same models directory — models are loaded
before extensions automatically.

### "Method 'X' already exists on model type 'Y'"

The extension tries to add a method with the same name as an existing method.
Extensions can only add new methods, not override existing ones. Use a different
method name.

### "Duplicate method name 'X' within extension methods array"

The same method name appears in multiple elements of the `methods` array within
a single extension file. Each method name must be unique across all array
elements.

### "No such key: &lt;specName&gt;" in CEL expressions

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

**3. Model has never been executed.** The `resource` key on `model.<name>` is
only populated if the model has produced data (a method was run that called
`writeResource`). If no data exists, `model.<name>` has `input` and `definition`
keys but no `resource` key. Run the create method or workflow first, or check
with `swamp data list <model-name>` to verify data exists.

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

### Syntax errors on load

Extension models are loaded as JavaScript at runtime. Avoid TypeScript-only
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

| Priority | Method               | Example                          |
| -------- | -------------------- | -------------------------------- |
| 1        | Environment variable | `SWAMP_MODELS_DIR=./custom/path` |
| 2        | `.swamp.yaml` config | `modelsDir: "lib/models"`        |
| 3        | Default              | `extensions/models`              |

## Verification Commands

```bash
# Verify model loads
swamp model type search --json

# Check model schema
swamp model type describe @myorg/my-model --json

# Test the model
swamp model create @myorg/my-model test --set fieldName="test"
swamp model method run test methodName --json
```
