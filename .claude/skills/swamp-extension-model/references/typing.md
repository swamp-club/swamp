# Execute function typing — the `satisfies` escape hatch

This reference applies **only when your `_test.ts` file imports the model source
directly.** If your tests do not import the model source, you do not need this
page — the default unannotated form in the
[Quick Start](../SKILL.md#quick-start) works without any changes.

## The problem

The default extension-model shape uses unannotated execute parameters:

```typescript
import { z } from "npm:zod@4";

export const model = {
  type: "@myorg/my-model",
  version: "2026.04.21.1",
  globalArguments: z.object({ region: z.string() }),
  methods: {
    run: {
      description: "Run the model",
      arguments: z.object({ bucket: z.string() }),
      execute: async (args, context) => {
        // args and context are contextually typed from the
        // inferred shape of `model` — works fine in isolation.
        return { dataHandles: [] };
      },
    },
  },
};
```

This is valid TypeScript. Swamp loads the model at runtime, validates it against
the canonical shape, and everything works.

**Where it breaks:** when a sibling `_test.ts` file imports the source:

```typescript
// my_model_test.ts
import { model } from "./my_model.ts";
// ...
```

Deno type-checks the imported source under the repo's `strict: true` compiler
options. Without an anchor type, TS cannot infer the parameters of inline method
`execute` functions and reports:

```
TS7006 [ERROR]: Parameter 'args' implicitly has an 'any' type.
TS7006 [ERROR]: Parameter 'context' implicitly has an 'any' type.
```

Models whose tests do not import the source (for example because the test stubs
the CLI rather than the model literal) silently escape the problem, producing an
inconsistent experience across the ecosystem.

## The escape hatch

Wrap the model literal with
`satisfies ModelDefinition<typeof YourGlobalArgsSchema>` from
`@systeminit/swamp-testing`:

```typescript
import { z } from "npm:zod@4";
import type { ModelDefinition } from "jsr:@systeminit/swamp-testing";

const GlobalArgsSchema = z.object({ region: z.string() });

export const model = {
  type: "@myorg/my-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the model",
      arguments: z.object({ bucket: z.string() }),
      execute: async (args, context) => {
        // context.globalArgs narrows to { region: string } — you get
        // type safety on the typed parts of the execution context
        // without any annotation on the execute parameters.
        return { dataHandles: [] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
```

Nothing inside `execute` changes. The only addition is the trailing
`satisfies ModelDefinition<typeof GlobalArgsSchema>` and the type-only import.

## What changes, concretely

Before (with `// deno-lint-ignore no-explicit-any` and `: any`):

```typescript
// deno-lint-ignore no-explicit-any
execute: async (_args: any, context: any) => {
  context.globalArgs.region // hover: any
  context.writeResource(...) // no autocomplete
}
```

After (`satisfies ModelDefinition<typeof GlobalArgsSchema>`):

```typescript
execute: async (_args, context) => {
  context.globalArgs.region // hover: string — narrowed from the schema
  context.writeResource(...) // full autocomplete and argument checking
}
```

## Narrowing `args` per method

`args` inside each execute body is typed via `z.infer<z.ZodTypeAny>` —
effectively `any`. This resolves TS7006 but does not give you the specific shape
of the method's `arguments` schema. To narrow `args` at the top of an execute
body, parse it with the method's schema:

```typescript
const RunArgsSchema = z.object({ bucket: z.string() });

methods: {
  run: {
    description: "Run the model",
    arguments: RunArgsSchema,
    execute: async (args, context) => {
      const { bucket } = RunArgsSchema.parse(args);
      // bucket: string — fully typed from here on
      return { dataHandles: [] };
    },
  },
},
```

Swamp already validates `args` against the schema before calling `execute`, so
the `.parse()` call is a compile-time helper, not a runtime safety net — feel
free to use `as z.infer<typeof RunArgsSchema>` if you prefer an assertion over a
parse call.

## When not to use this

- **Your tests do not import the model source.** The unannotated default form
  works — don't add the import or the `satisfies` clause.
- **You want the simplest possible model file.** The default unannotated form is
  still the recommended Quick Start for new extensions.
- **You are comfortable with inline context shapes.** If your model already
  declares `context: { globalArgs: ..., logger: ..., ... }` inline, that
  continues to work and does not conflict with the escape hatch.

## `defineModel` alternative

If you prefer a function-form wrapper to `satisfies`, the testing package also
exports `defineModel`:

```typescript
import { defineModel } from "jsr:@systeminit/swamp-testing";

export const model = defineModel({
  type: "@myorg/my-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {/* ... */},
});
```

Contract is identical to `satisfies ModelDefinition<...>` — same narrowing
behavior, just different call-site syntax. Runtime cost is zero (`defineModel`
returns its input unchanged).

## References

- Swamp Club issue [#141](https://swamp.club/lab/issues/141) — the original DX
  gap that motivated this escape hatch.
- `src/domain/models/testing_package_compat_test.ts` — CI test that keeps the
  testing-package `ModelDefinition` structurally aligned with the canonical
  `ModelDefinition` in `src/domain/models/model.ts`. If the two drift, this test
  fails.
- [`references/testing.md`](testing.md) — unit-testing patterns for extension
  models; read this if you are writing the tests that originally triggered
  TS7006.
