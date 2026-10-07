# Code Review

Review this change for correctness, conventions, and quality.

The diff under review is provided as a file; its path is given at the end of
this prompt. Read that file first — it is the complete and only set of changes
you are reviewing. You may read other files in the repository for context, but
every finding must be about a change in the diff. Do not review unchanged code,
and do not comment on commits or files the diff does not contain.

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

Pay special attention to the libswamp import boundary: `src/libswamp/mod.ts`
lists the public surface and is never imported. CLI commands and presentation
renderers import each name from the libswamp file that defines it, and only
names that `mod.ts` exports from that file.

## Severity Classification

- **Blocking**: Bugs, security issues, type errors, missing tests for new code,
  violations of CLAUDE.md requirements. These must be fixed.
- **Suggestion**: Style preferences, optional refactoring, documentation
  improvements. These do not block.
