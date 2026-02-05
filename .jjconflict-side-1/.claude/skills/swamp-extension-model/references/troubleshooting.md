# Troubleshooting Extension Models

## Common Errors

### "No 'model' export found"

Must use named export:

```typescript
// Wrong
const model = { ... };

// Correct
export const model = { ... };
```

### "Model must have at least one of resourceAttributesSchema or dataAttributesSchema"

Add either `dataAttributesSchema` (ephemeral) or `resourceAttributesSchema`
(persistent):

```typescript
export const model = {
  type: "...",
  version: 1,
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema,  // Add this
  methods: { ... },
};
```

### "Model type already registered"

Type name conflicts with built-in or another user model. Use namespaced names:

```typescript
// Avoid
type: "echo"; // May conflict

// Use
type: "mycompany/echo"; // Unique
```

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
swamp type describe myorg/my-model --json

# Test the model
swamp model create myorg/my-model test --set fieldName="test"
swamp model method run test methodName --json
```
