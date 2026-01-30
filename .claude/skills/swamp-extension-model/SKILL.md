---
name: swamp-extension-model
description: Create user-defined TypeScript models for swamp. Use when users want to extend swamp with custom model types, create automation models, or add new integrations. Triggers on "create model", "new model type", "custom model", "extension model", or "user model".
---

# Swamp Extension Model

Create TypeScript models in `extensions/models/*.ts` that swamp loads at
startup.

## Quick Start

```typescript
// extensions/models/my_model.ts
import { z } from "npm:zod@4";

const InputSchema = z.object({ message: z.string() });
const DataSchema = z.object({ result: z.string(), timestamp: z.string() });

export const model = {
  type: "myorg/my-model",
  version: 1,
  inputAttributesSchema: InputSchema,
  dataAttributesSchema: DataSchema, // Use resourceAttributesSchema for persistent output
  methods: {
    run: {
      description: "Process the input",
      execute: async (input, _context) => ({
        data: {
          id: input.id,
          attributes: {
            result: input.attributes.message.toUpperCase(),
            timestamp: new Date().toISOString(),
          },
        },
      }),
    },
  },
};
```

## Model Structure

| Field                      | Required | Description                            |
| -------------------------- | -------- | -------------------------------------- |
| `type`                     | Yes      | Unique identifier (`namespace/name`)   |
| `version`                  | Yes      | Schema version number                  |
| `inputAttributesSchema`    | Yes      | Zod schema for input validation        |
| `dataAttributesSchema`     | Pick one | For ephemeral output (not git-tracked) |
| `resourceAttributesSchema` | Pick one | For persistent output (git-tracked)    |
| `methods`                  | Yes      | Object of method definitions           |

## Execute Function

```typescript
execute: (async (input, context) => {
  // input.id        - UUID
  // input.name      - User-provided name
  // input.attributes - Validated input data
  // context.repoDir - Repository root path

  return {
    data: { // Or 'resource' for resourceAttributesSchema
      id: input.id,
      attributes: {/* output fields */},
    },
  };
});
```

## Key Rules

1. **Export**: Must use `export const model = { ... }`
2. **Import**: Only `import { z } from "npm:zod@4";` is needed
3. **Type naming**: Use `namespace/name` format to avoid conflicts
4. **No type annotations**: Avoid TypeScript types in execute parameters
5. **File naming**: Use snake_case (`my_model.ts`), test files excluded

## References

- **Complete examples**: See [references/examples.md](references/examples.md)
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md)

## Verify

```bash
swamp type search --json              # Model should appear
swamp type describe myorg/my-model    # Check schema
```
