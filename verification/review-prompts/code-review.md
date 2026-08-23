# Code Review

Review this change for correctness, conventions, and quality.

First, run `git diff main --name-only` to identify the changed files. Only
review those files — do not review unchanged code.

Read the project's CLAUDE.md to understand code style, conventions, and
requirements. Use the `ddd` skill to review for domain-driven design principles.

## Review Dimensions

1. **CLAUDE.md adherence** — does the change follow all conventions and
   requirements defined in the project's CLAUDE.md?
2. **Domain-driven design** — are DDD principles applied correctly? (Use the ddd
   skill.)
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
  violations of CLAUDE.md requirements. These must be fixed.
- **Suggestion**: Style preferences, optional refactoring, documentation
  improvements. These do not block.
