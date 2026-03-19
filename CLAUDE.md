# Project: swamp

Deno based CLI for doing AI Native Automation.

## Planning

When planning new features, always use the `ddd` skill to inform the
architecture.

## Skills

When creating or updating `swamp-*` skills in `.claude/skills/`, follow the
`skill-creator` skill guidelines to ensure consistent structure and quality.

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

Changes should only touch what's necessary — don't refactor adjacent code that
isn't part of the task. Keep the blast radius small.

Post-edit hooks in `.claude/hooks/` automatically run license headers,
`deno fmt`, and `deno lint --fix` on each changed file.

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
- When a PR fixes a GitHub issue filed by an external contributor (not a repo
  collaborator), add them as a co-author to the commit. Check with
  `gh api /repos/systeminit/swamp/collaborators --jq '.[].login'` to determine
  if the issue author is a team member. If they are not, add
  `Co-authored-by: Name <email>` to the commit. Use `gh api /users/<username>`
  to look up their name, and use `<username>@users.noreply.github.com` as the
  email unless a public email is available from the API response.

## Verification

Post-edit hooks in `.claude/hooks/` automatically run license headers,
`deno fmt`, and `deno lint --fix` on each changed file. A Stop hook in
`.claude/hooks/stop-verify.sh` runs project-wide `deno check`, `deno lint`, and
`deno run test` before completion — blocking until all pass. After completing
all work, run `deno run compile` to recompile the binary.

## Architecture

- Follows domain driven design principles. Use the `ddd` skill when designing or
  reviewing code.
- Uses Cliffy for the command line
- Uses Ink for interactive terminal UIs (search, TUI dashboard)
- Uses LogTape for logging and non-interactive output (`"log"` mode)
- Uses JSON for structured output (`"json"` mode via `--json`)
- Every command _must_ support both `"log"` and `"json"` output modes
- You can read the files in `design/*.md` to understand elements of the design

IMPORTANT: CLI commands and presentation renderers must import libswamp types
and functions from `src/libswamp/mod.ts` — never from internal module paths like
`src/libswamp/data/get.ts`. Only libswamp-internal code (other generators, tests
in `src/libswamp/`) may import from internal paths.

## Testing

- Unit tests live next to source files: `foo.ts` → `foo_test.ts`
- Integration tests live in `integration/` directory (sibling to `src/`)
- Use `@std/assert` for assertions (`assertEquals`, `assertStringIncludes`,
  `assertThrows`, etc.)
- Use `ink-testing-library` for testing Ink components
- Test private functions indirectly through public APIs
- Name tests as `Deno.test("functionName: describes behavior", ...)` — see
  `src/domain/data/composite_name_test.ts` for a canonical example
- Run all tests with `deno run test`
- Run a single test file: `deno run test src/cli/repo_context_test.ts` (do not
  use `--` before the file path)
- Refactorings that change shared constants, paths, or cross-component contracts
  must include integration tests to verify components still work together

IMPORTANT: CLI command tests require logging initialization and model barrel
imports before they can run. See `src/cli/commands/data_get_test.ts` for the
pattern (`await initializeLogging({})` and
`import "../../domain/models/models.ts"`).

## Output Conventions

- When asked to produce a plan, design, or analysis, persist it to
  `plans/<descriptive-name>.md` — the file is the source of truth.
- When asked for a plan or design only, produce only that artifact. Do not write
  production code or make implementation changes unless explicitly asked.
- When exploring a codebase, produce a first draft of output within 3-4 tool
  calls. Refine iteratively rather than front-loading all exploration.

## Session Learnings

If you hit a non-obvious problem during a session — something that wasted time,
caused a wrong approach, or revealed a convention not documented here — propose
an update to CLAUDE.md or the relevant skill before finishing. Only capture
things that would trip up future sessions, not one-off issues.
