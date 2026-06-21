# Execute function typing

Extension model `execute` callbacks receive `args` and `context` from the swamp
runtime. Under Deno's strict TypeScript mode, unannotated parameters produce
TS7006 when a sibling `_test.ts` file imports the model source. This page
documents the recommended typing patterns.

## The problem

The default extension-model shape uses unannotated execute parameters:

```typescript
execute: (async (args, context) => {/* ... */});
```

This is valid TypeScript in isolation. But when a sibling `_test.ts` file
imports the source, Deno type-checks it under strict mode and reports:

```
TS7006 [ERROR]: Parameter 'args' implicitly has an 'any' type.
TS7006 [ERROR]: Parameter 'context' implicitly has an 'any' type.
```

## Recommended pattern: inline type annotations

Type `args` using `z.infer<typeof YourSchema>` and type `context` inline with
only the fields the method uses. This requires no external imports beyond `zod`
(already present in every extension):

```typescript
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({ region: z.string() });
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RunArgsSchema = z.object({ bucket: z.string() });

export const model = {
  type: "@myorg/my-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the model",
      arguments: RunArgsSchema,
      execute: async (
        args: z.infer<typeof RunArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info(msg: string, ...args: unknown[]): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info("Processing bucket {bucket}", args.bucket);
        const handle = await context.writeResource("result", "main", {
          region: context.globalArgs.region,
          bucket: args.bucket,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
```

### Key conventions

- **Type only the context fields you use.** Don't declare all 12 fields — just
  the ones the method body references. This keeps signatures readable.
- **Use `z.infer<typeof Schema>` for args.** This gives you the exact shape
  validated by the runtime, with zero duplication.
- **Use `_args: Record<string, never>` for methods with no arguments.** This is
  clearer than `_args: unknown` or `_args: z.infer<typeof z.object({})>`.
- **Define a `type GlobalArgs = z.infer<typeof GlobalArgsSchema>` alias** at the
  top of the file for reuse across methods.

### Available context fields

Every `execute` callback receives these fields on `context`. Type only what you
use:

| Field                  | Type signature                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `signal`               | `AbortSignal`                                                                                  |
| `repoDir`              | `string`                                                                                       |
| `globalArgs`           | `z.infer<typeof YourGlobalArgsSchema>`                                                         |
| `definition`           | `{ id: string; name: string; version: string; tags: Record<string, string> }`                  |
| `methodName`           | `string`                                                                                       |
| `logger`               | `{ info(msg: string, ...args: unknown[]): void; ... }` (trace/debug/info/warning/error/fatal)  |
| `writeResource`        | `(specName: string, name: string, data: Record<string, unknown>) => Promise<{ name: string }>` |
| `readResource`         | `(instanceName: string, version?: number) => Promise<Record<string, unknown> \| null>`         |
| `deleteResource`       | `(instanceName: string) => Promise<void>`                                                      |
| `createFileWriter`     | `(specName: string, name: string) => DataWriter`                                               |
| `createCelEnvironment` | `() => Environment`                                                                            |
| `dataRepository`       | Low-level data API (for reading non-JSON content)                                              |
| `modelType`            | `string`                                                                                       |
| `modelId`              | `string`                                                                                       |

## Alternative: `satisfies ModelDefinition`

If you prefer not to annotate each method individually, you can wrap the model
literal with `satisfies ModelDefinition<typeof GlobalArgsSchema>` from
`@swamp-club/swamp-testing`:

```typescript
import type { ModelDefinition } from "jsr:@swamp-club/swamp-testing";

export const model = {
  type: "@myorg/my-model",
  version: "2026.04.21.1",
  globalArguments: GlobalArgsSchema,
  methods: {
    run: {
      description: "Run the model",
      arguments: RunArgsSchema,
      execute: async (args, context) => {
        // context.globalArgs narrows to { region: string }
        // args is z.infer<z.ZodTypeAny> — effectively `any`
        const { bucket } = RunArgsSchema.parse(args);
        return { dataHandles: [] };
      },
    },
  },
} satisfies ModelDefinition<typeof GlobalArgsSchema>;
```

This resolves TS7006 and narrows `context.globalArgs`, but `args` remains
untyped — you need `.parse(args)` at the top of each execute body to recover the
specific shape. The inline annotation pattern (above) is preferred because it
gives full type safety on both `args` and `context` without additional imports.

### `defineModel` function form

The testing package also exports `defineModel` — identical behaviour to
`satisfies`, different call-site syntax:

```typescript
import { defineModel } from "jsr:@swamp-club/swamp-testing";

export const model = defineModel({
  type: "@myorg/my-model",
  // ...
});
```

Same trade-off: `context.globalArgs` narrows, `args` remains `any`.

## When not to use any of this

- **Your tests do not import the model source.** The unannotated form works fine
  — don't add annotations you don't need.
- **You are comfortable with `: any`.** The workaround
  `execute: async (args: any, context: any) =>` continues to work and push. It
  sacrifices type safety but is not a blocker.
