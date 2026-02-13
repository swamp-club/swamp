---
name: terminal-output
description: Terminal output design system for swamp CLI commands. Use when creating or modifying any CLI command output, render function, or presentation layer code. Ensures consistent formatting, coloring, and structure across all swamp commands in both "log" (human-readable) and "json" (structured) output modes. Triggers on output files in src/presentation/output/, render functions, writeOutput usage, OutputMode handling, or any CLI command that produces terminal output.
---

# Terminal Output Design System

Consistent, human-readable terminal output for the swamp CLI.

## Two Output Modes

Every command **must** support both modes, controlled by `--json` flag:

- `"log"` (default) - Clean, colored, human-readable plain text
- `"json"` - Structured JSON for scripting and automation

The mode is available as `ctx.outputMode` from `createContext()` in
`src/cli/context.ts`.

## Architecture

```
src/cli/commands/<command>.ts     → Command logic, builds data object
src/presentation/output/<name>_output.ts → Render function, formats output
src/infrastructure/logging/logger.ts     → writeOutput() + LogTape loggers
```

### Output File Pattern

Each command has a dedicated output file that exports:

1. A **data interface** describing the output shape
2. A **render function** that branches on `OutputMode`

```typescript
import { bold, cyan, dim } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface ExampleData {
  name: string;
  type: string;
}

export function renderExample(data: ExampleData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const lines = [
      `${bold(cyan("Name:"))} ${bold(data.name)} ${dim(`(${data.type})`)}`,
    ];
    writeOutput(lines.join("\n"));
  }
}
```

## Log Mode vs LogTape

See [references/logtape.md](references/logtape.md) for details on how LogTape
and `writeOutput()` coexist and when to use each.

**Key rule:** Render functions use `writeOutput()` for user-facing output, never
LogTape. LogTape is for debug/operational logging only.

## Color Scheme

Import from `@std/fmt/colors`. Colors auto-respect `NO_COLOR` env var and the
`--no-color` flag (handled in `src/cli/mod.ts` via `setColorEnabled(false)`).

| Element              | Style             | Example                |
| -------------------- | ----------------- | ---------------------- |
| Section headers/keys | `bold(cyan(...))` | **Created:** **Path:** |
| Primary values       | `bold(...)`       | **my-model**           |
| Sub-section headers  | `cyan(...)`       | Input Attributes:      |
| Metadata/types       | `dim(...)`        | _(string)_ _*required_ |
| Enum values          | `dim(...)`        | _[a, b, c]_            |
| Type annotations     | `dim(...)`        | _(command/shell)_      |
| Pass indicator       | `green(...)`      | PASSED, checkmark      |
| Fail indicator       | `red(...)`        | FAILED, cross          |
| Separators           | `dim("-")`        | method - description   |

## Layout Rules

### Lines Array Pattern

Always build output as a `string[]` and join at the end:

```typescript
const lines: string[] = [];
lines.push(`${bold(cyan("Header:"))} ${value}`);
// ...
writeOutput(lines.join("\n"));
```

### Spacing

- **Blank line** before each new section (Input Attributes, Methods, Jobs)
- **Blank line** between entries in "validate all" / list-style output
- **Blank line** before summary/result lines in multi-entry output
- **No blank lines** between items within a section (e.g., between methods)

### Indentation Hierarchy

```
Top-level key: value                    ← no indent
  Second level (attributes, items)      ← 2 spaces
    Third level (sub-sections)          ← 4 spaces
      Fourth level (sub-items)          ← 6 spaces
```

### Shared Formatters

Reuse these exported functions from `type_describe_output.ts`:

- `formatSchemaAttributes(schema, indent)` - JSON Schema to attribute lines
- `formatMethodLines(methods)` - Method descriptions with attributes and data
  outputs

Reuse `toMethodDescribeData()` and `zodToJsonSchema()` from
`src/cli/commands/type_describe.ts` to convert domain objects to presentation
data.

## Validation Output Pattern

For pass/fail validation results:

```typescript
const checkmark = "\u2713"; // ✓
const cross = "\u2717"; // ✗
const arrow = "\u2192"; // →

// Passing
lines.push(`  ${green(checkmark)} ${name}`);

// Failing
lines.push(`  ${red(cross)} ${name}`);
lines.push(`    ${red(arrow)} ${errorMessage}`);

// Result
lines.push(
  passed
    ? `${bold(cyan("Result:"))} ${green("PASSED")}`
    : `${bold(cyan("Result:"))} ${red("FAILED")}`,
);
```

## JSON Mode Rules

- Use `console.log(JSON.stringify(data, null, 2))` directly
- The data interface defines the JSON shape - keep it clean and consistent
- Include all fields (even optional ones when present) for scripting consumers
- No colors, no formatting - just the data

## Testing

- Test file: `<name>_output_test.ts` next to the output file
- Capture `console.log` output by stubbing it
- Use `stripAnsiCode` from `@std/fmt/colors` for color-aware assertions
- Test both `"json"` and `"log"` modes
- For JSON mode: parse output and assert field values
- For log mode: assert key strings are present in stripped output

```typescript
import { assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";

Deno.test("log mode shows expected content", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderExample(testData, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Expected:");
  } finally {
    console.log = originalLog;
  }
});
```
