# LogTape and writeOutput

## Two Output Systems

Swamp has two distinct output paths:

### 1. LogTape (operational/debug logging)

LogTape is configured in `src/infrastructure/logging/logger.ts` and provides
structured logging with timestamps, levels, and category prefixes.

```
12:34:56 INF model.create Creating model definition: type=command/shell, name=test
```

**Use LogTape for:**

- Debug messages (`ctx.logger.debug`)
- Internal operational logs
- Run file logging (model method runs, workflow runs)
- Anything the user does NOT see in normal mode

**Access via:** `getSwampLogger(category)` or `ctx.logger` from command context.

**Important characteristics:**

- LogTape v2 uses `@logtape/logtape` and `@logtape/pretty`
- Configured once per process via `initializeLogging()`
- In `--json` mode, LogTape is suppressed to `"fatal"` level only, with a
  special JSON error sink on stderr
- Pretty output (colored, formatted) is enabled when stdin is a TTY and
  `--no-color` is not set
- LogTape message templates wrap values in quotes:
  `logger.info("Type: {name}", { name })` outputs `Type: "name"` - this is why
  it is unsuitable for user-facing output
- LogTape propagates messages up the category hierarchy - there is no way to
  override parent sinks in v2 (`parentSinks: "override"` is not available)
- Run-specific categories (`["model", "method", "run"]` and
  `["workflow", "run"]`) are additionally routed to a run file sink for
  persistent logging

### 2. writeOutput (user-facing CLI output)

`writeOutput()` in `logger.ts` bypasses LogTape entirely and writes directly to
`console.log`. It produces clean, undecorated output.

```typescript
export function writeOutput(message: string): void {
  console.log(message);
}
```

**Use writeOutput for:**

- All user-facing output in `"log"` mode
- Render functions in `src/presentation/output/`
- Anything the user reads as the primary command result

**Why not LogTape for user output?**

1. LogTape decorates output with timestamps, log level, and category prefixes
   that clutter user-facing results
2. LogTape wraps template values in quotes (e.g., `"command/shell"` instead of
   `command/shell`)
3. LogTape has no way to create a "plain" sink without parent propagation in v2,
   causing double output if you try
4. User output should read like a clean document, not a log stream

## How They Coexist

In a typical command:

```typescript
// Command file (src/cli/commands/example.ts)
export const exampleCommand = new Command()
  .action(async function (options) {
    const ctx = createContext(options, ["example"]);

    // LogTape: debug logging for developers
    ctx.logger.debug`Starting example command`;

    // ... do work ...

    // writeOutput: user-facing result via render function
    renderExample(data, ctx.outputMode);

    // LogTape: debug logging
    ctx.logger.debug("Example command completed");
  });
```

```typescript
// Render function (src/presentation/output/example_output.ts)
export function renderExample(data: ExampleData, mode: OutputMode): void {
  if (mode === "json") {
    // Direct console.log for JSON mode
    console.log(JSON.stringify(data, null, 2));
  } else {
    // writeOutput for log mode
    const lines = [...];
    writeOutput(lines.join("\n"));
  }
}
```

## LogTape Configuration Summary

Configured in `initializeLogging()`:

| Condition             | Root logger level | Sink           |
| --------------------- | ----------------- | -------------- |
| Normal (TTY)          | info              | pretty         |
| Normal (non-TTY)      | info              | console        |
| `--json`              | fatal             | jsonError      |
| `--quiet`             | error             | console/pretty |
| `--log-level <level>` | specified level   | console/pretty |
| `--no-color`          | info              | console (text) |

The pretty sink uses `@logtape/pretty` with dimmed timestamps/levels, bold green
categories, and aligned output.

## Color Support

Colors for `writeOutput` content come from `@std/fmt/colors`, **not** LogTape:

- `@std/fmt/colors` checks `Deno.noColor` at startup
- `--no-color` flag sets `NO_COLOR=1` env var AND calls `setColorEnabled(false)`
  at runtime (in `src/cli/mod.ts`)
- Both must be done because `@std/fmt/colors` reads the env var only at import
  time

## Migration Pattern

When converting a render function from LogTape to writeOutput:

1. Replace `import { getSwampLogger }` with `import { writeOutput }` from
   logger.ts
2. Add `import { bold, cyan, dim } from "@std/fmt/colors"`
3. Replace `logger.info(...)` calls with `lines.push(...)` using color helpers
4. End with `writeOutput(lines.join("\n"))`
5. Keep JSON mode unchanged (`console.log(JSON.stringify(...))`)

Files still using the old LogTape pattern for user output (candidates for
migration): check for `getSwampLogger` usage in `src/presentation/output/` files
where the logger is used in the `else` (log mode) branch of render functions.
