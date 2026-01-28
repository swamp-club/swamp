# Project: swamp

Deno based CLI for doing AI Native Automation.

## Code Style

- TypeScript strict mode, no `any` types
- Use named exports, not default exports
- Comprehensive unit test coverage
- All code must pass type checking with `deno check`
- All code must pass `deno lint`
- Format all code with `deno fmt`

## Commands

Use `deno run` to get a complete list of custom tasks.

- `deno run dev`: Run the CLI.
- `deno run test`: Run the test suite.
- `deno check`: Type-check the program.
- `deno lint`: Run lints.
- `deno fmt`: Format the code.

## Source Control

- Uses jujutsu (jj) for source control. Use the `jututsu` skill.

## Architecture

- Follows domain driven design principles. Use the `ddd` skill when designing or
  reviewing code.
- Uses Cliffy for the command line
- Uses Ink for interactive output
- Uses LogTape for logging
- Uses JSON for non-interactive output
- Every command _must_ support both interactive and non-interactive output

## Testing

- Unit tests live next to source files: `foo.ts` → `foo_test.ts`
- Integration tests live in `integration/` directory (sibling to `src/`)
- Use `@std/assert` for assertions (`assertEquals`, `assertStringIncludes`, etc.)
- Use `ink-testing-library` for testing Ink components
- Test private functions indirectly through public APIs
- Run tests with `deno task test`
