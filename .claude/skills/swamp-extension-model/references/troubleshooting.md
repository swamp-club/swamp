# Troubleshooting Extension Models

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

### "Model must have at least one of resourceAttributesSchema or dataAttributesSchema"

Add either `dataAttributesSchema` (ephemeral) or `resourceAttributesSchema`
(persistent):

```typescript
export const model = {
  type: "...",
  version: "2026.02.09.1",
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,  // Add this
  methods: { ... },
};
```

### "Model type already registered"

Type name conflicts with built-in or another user model. Use unique names within
the `@user` namespace:

```typescript
// Avoid
type: "@user/echo"; // May conflict with other users

// Use
type: "@user/mycompany/echo"; // More unique
```

### "Model type must use '@' prefix"

User-defined models must use the `@user` namespace:

```typescript
// Wrong - missing @user namespace
type: "mycompany/echo";

// Correct
type: "@user/echo";
type: "@user/mycompany/echo";
```

### "Namespace 'X' is not allowed"

Only the `@user` namespace is currently allowed for user models. Reserved
namespaces (`swamp`, `si`) are for built-in types:

```typescript
// Wrong - reserved namespace
type: "swamp/my-model";
type: "@swamp/my-model";

// Wrong - custom namespace not allowed yet
type: "@mycompany/echo";

// Correct
type: "@user/my-model";
```

### "Cannot extend unregistered model type: ..."

The extension targets a model type that isn't registered. Ensure the type string
matches exactly (e.g., `"swamp/echo"`, not `"echo"`). If extending a user model,
both files must be in the same models directory — models are loaded before
extensions automatically.

### "Method 'X' already exists on model type 'Y'"

The extension tries to add a method with the same name as an existing method.
Extensions can only add new methods, not override existing ones. Use a different
method name.

### "Duplicate method name 'X' within extension methods array"

The same method name appears in multiple elements of the `methods` array within
a single extension file. Each method name must be unique across all array
elements.

### Syntax errors on load

Avoid inline TypeScript type annotations in execute parameters:

```typescript
// Wrong - causes syntax error
execute: async (input: { id: string }, context: any) => { ... }

// Correct
execute: async (input, _context) => { ... }
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
swamp type search --json

# Check model schema
swamp type describe @user/my-model --json

# Test the model
swamp model create @user/my-model test --set fieldName="test"
swamp model method run test methodName --json
```
