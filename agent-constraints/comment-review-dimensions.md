# Comment Review Dimensions

Dimensions for the `comment-review` step: whether the comments a change adds
carry information the code cannot. The "Comments" section of `AGENTS.md` is the
standard, and this file is its enforcement.

Be adversarial about **added** comment lines. A diff that adds no comments
passes, and that is a good outcome: a change that needs no explanation is the
normal case.

`deno fmt` and `deno lint` own a comment's shape. This review owns its content.
A comment that states something false, or restates the line beneath it, costs
the next reader more than no comment at all.

## Scope

- Judge only comment lines the diff **adds or modifies**. Comments already in a
  touched file never block; list them under "Pre-existing observations".
- **In scope**: comments in `.ts` and `.tsx` files under `src/`, `integration/`
  and `scripts/`, test files included, and `AGENTS.md`.
- **Out of scope**:
  - lint, format, coverage and compiler pragmas (`deno-lint-ignore`,
    `deno-fmt-ignore`, `deno-coverage-ignore`, `@ts-expect-error`, `@ts-ignore`,
    triple-slash references, JSX pragmas)
  - `packages/`, `extensions/`, `evals/` and root-level files
  - the licence header
  - generated files, including their "generated" notice
  - text inside string or template literals, which is program output rather than
    a comment
  - markdown documentation, `agent-constraints/`, `design/` and skills, all of
    which may cite issues, measurements and history

## What blocks

**HIGH: the comment states what the code already says.** Narration above the
line it narrates, a JSDoc block repeating a signature or a parameter's name, a
test comment repeating its assertion, a section banner or a numbered phase
label. The fix is deletion.

**HIGH: the comment cites an issue, or carries history, a measurement or a
date.** An issue or pull request reference in any form, a calendar date, an
observed timing or count, or an account of what the code did before ("no
longer", "this replaced", "previously"). Git holds all of these. This blocks
even when the surrounding sentence is a genuine decision; the fix is to rewrite
the sentence without them. A number that is a domain constant the sentence is
about (a retry limit, a size cap) is not a measurement.

**HIGH: the comment tells the reader to run a command.** Regeneration steps,
verification steps and shell recipes belong in the contributing docs. Naming a
CLI form because the code beneath parses or handles that form is allowed.

**HIGH: an essay.** A comment longer than three lines anywhere, or a file header
describing architecture or rationale. The fix is to keep the one decision that
matters, at the line it governs, and move any lasting design explanation to
`design/`.

**HIGH: the comment is false, or contradicts the code beneath it.** This is the
most expensive failure, because such a comment survives by looking approximately
right. Read the code, not just the comment. A comment naming a function, flag,
type or behavior the code does not have blocks.

**HIGH: `AGENTS.md` grows a narrative.** A multi-paragraph subsystem essay, an
issue citation or a measurement.

## What warns

**MEDIUM: a decision that takes two or three lines and would survive
compression.** Invariants in concurrency, persistence and security code often
earn the extra lines; a comment there is a warning at most.

**MEDIUM: a useful comment away from the line it governs.** A blank line between
a comment and its code is how the two drift apart.

**MEDIUM: a comment restating a rule already stated in the same file.**

## What must not be flagged

- The absence of a comment. Never ask for one. If a reader would misread the
  code, that is a naming or structure problem for another review.
- A one-line comment carrying a real decision, tradeoff, limit or shrug, even a
  blunt one.
- The reason line in a `catch` body.
- A comment's deletion, except for the traps below.

## Removal traps

These are the only findings against deleted comment lines.

1. **CRITICAL: a deleted line that was not a comment.** Comment-like text inside
   a string or template literal is output, such as scaffolded source or help
   text. Removing it changes behavior.
2. **CRITICAL: an emptied block.** A `catch` or other block whose whole body was
   its comment fails `deno lint` once the comment goes. Keep a one-line reason.
3. **CRITICAL: a removed pragma.** A suppression deleted along with the prose
   around it fails lint, type checking or formatting.
4. **HIGH: a source-reading rule broken.** Architecture fitness tests read source
   text, and some of them look at comments. A deletion that makes one fail is
   not comment cleanup.
5. **HIGH: a deleted note that a symbol is unused on purpose.** Without it, the
   symbol reads as dead code.
6. **HIGH: a deleted invariant.** A comment stating a non-obvious rule that the
   code relies on, in concurrency, persistence, authorization or redaction, must
   be shortened rather than removed. If nothing in the remaining code or its
   names conveys the rule, flag the deletion.

## Calibration

None of these is a finding. Each carries information absent from the code, in
one line, with no reference, measurement or date:

```
// null means not known; zero is a real count
// the lease outlives this handle, so release it on every path
// fails closed: a missing grant is never read as allowed
// order matters: the marker lands after the data it vouches for
// retried once because parallel verifications race on this ref
// no production caller on purpose: tests pin the wire format with it
```

Judge an added comment by whether it belongs in that list.
