# Project: swamp

Deno based CLI for doing AI Native Automation.

## Planning

When planning new features, always use the `ddd` skill to inform the
architecture.

## Code Style

- TypeScript strict mode, no `any` types
- Use named exports, not default exports
- Comprehensive unit test coverage
- All code must pass type checking with `deno check`
- All code must pass `deno lint`
- Format all code with `deno fmt`
- All `.ts` and `.tsx` files must include the AGPLv3 copyright header from
  `FILE-LICENSE-TEMPLATE.md` at the top of the file (as `//` comments). Run
  `deno run license-headers` to add headers to any new files.

## Commands

Use `deno run` to get a complete list of custom tasks.

- `deno run dev`: Run the CLI.
- `deno run test`: Run the test suite.
- `deno check`: Type-check the program.
- `deno lint`: Run lints.
- `deno fmt`: Format the code.

## Source Control & Pull Requests

- Use the `github-pr` skill to create commit messages and pull requests.
- PRs are auto-merged after passing CI and Claude review. To prevent auto-merge,
  add the `hold` label to the PR.
- After completing work (finishing tasks, merging PRs), run `deno run compile`
  to recompile swamp.

## Verification

After completing work, run these checks:

1. `deno check` - Type checking
2. `deno lint` - Linting
3. `deno fmt` - Formatting
4. `deno run test` - Tests
5. `deno run compile` - Recompile the binary

## Architecture

- Follows domain driven design principles. Use the `ddd` skill when designing or
  reviewing code.
- Uses Cliffy for the command line
- Uses Ink for interactive terminal UIs (search, TUI dashboard)
- Uses LogTape for logging and non-interactive output (`"log"` mode)
- Uses JSON for structured output (`"json"` mode via `--json`)
- Every command _must_ support both `"log"` and `"json"` output modes
- You can read the files in `design/*.md` to understand elements of the design

## Testing

- Unit tests live next to source files: `foo.ts` → `foo_test.ts`
- Integration tests live in `integration/` directory (sibling to `src/`)
- Use `@std/assert` for assertions (`assertEquals`, `assertStringIncludes`,
  etc.)
- Use `ink-testing-library` for testing Ink components
- Test private functions indirectly through public APIs
- Run all tests with `deno task test`
- Run a single test file: `deno task test src/cli/repo_context_test.ts` (do not
  use `--` before the file path)
- Refactorings that change shared constants, paths, or cross-component contracts
  must include integration tests to verify components still work together
