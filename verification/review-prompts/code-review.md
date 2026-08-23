# Code Review

Review the diff provided below for correctness, conventions, and quality. Only
review the changed code — do not review unchanged code.

## Project Conventions (from CLAUDE.md)

- TypeScript strict mode, no `any` types
- Use named exports, not default exports
- Comprehensive unit test coverage
- All `.ts` and `.tsx` files must include the AGPLv3 copyright header
- No fire-and-forget promises — every promise must be awaited or explicitly
  handled
- Interpolate values bare in LogTape tagged templates
- CLI commands and presentation renderers must import libswamp types from
  `src/libswamp/mod.ts` — never from internal module paths
- Every command must support both `"log"` and `"json"` output modes
- Unit tests live next to source files: `foo.ts` → `foo_test.ts`
- Changes should only touch what's necessary — keep the blast radius small
- Follows domain driven design principles (entities, value objects, aggregates,
  domain services, repositories)

## Review Dimensions

1. **Convention adherence** — does the change follow the conventions listed above?
2. **Domain-driven design** — are DDD principles applied correctly? Are domain
   boundaries respected? Are value objects used where appropriate?
3. **Test coverage** — are there unit tests for new code? Do tests live next to
   source files?
4. **Security** — are there vulnerabilities or unsafe patterns?
5. **Bugs and edge cases** — are there logic errors, off-by-one mistakes, or
   unhandled scenarios?

Pay special attention to the libswamp import boundary: CLI commands and
presentation renderers must import from `src/libswamp/mod.ts` — never from
internal module paths.

## Severity Classification

- **Blocking**: Bugs, security issues, type errors, missing tests for new code,
  violations of conventions above. These must be fixed.
- **Suggestion**: Style preferences, optional refactoring, documentation
  improvements. These do not block.
