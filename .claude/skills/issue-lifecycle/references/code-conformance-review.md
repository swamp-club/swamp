# Code Conformance Review

Read this after the implementation is complete and before creating a PR. The
code conformance review compares what was actually built against the approved
plan. Deviations are expected — implementations always discover things the plan
didn't anticipate. The value is in documenting **why** the code differs.

**This review is mandatory.** Both `link_pr` and `complete` will fail if no
conformance review exists or if any deviations lack justifications.

## Step 1: Retrieve the Approved Plan

```
swamp data get issue-<N> plan-main --json
```

Parse the plan to get the step list, DDD analysis, testing strategy, and
potential challenges. Note the plan version — the conformance review must
reference it.

## Step 2: Review the Code Changes

Diff the branch against main to see all changes:

```
git diff main...HEAD --stat
git diff main...HEAD
```

For each plan step, read the files listed in the step and verify the described
change exists in the diff. Record the status:

- `implemented` — the code matches what the plan described
- `deviated` — the code does something different than planned
- `partially_implemented` — some but not all of the step was done
- `missing` — the step was not implemented at all
- `added` — a change exists in the diff that no plan step covers

## Step 3: Document Justifications Upfront

For any step that is not `implemented`, provide a justification if you already
understand why. Common justifications:

- "Discovered existing helper function, skipped implementing from scratch"
- "Step was unnecessary — the existing code already handled this case"
- "Combined with step N for cleaner implementation"
- "Approach changed after discovering X during implementation"
- "Added defensive validation not anticipated in the plan"

Steps where you don't know the justification should be left without one — the
human will explain.

## Step 4: Read Review Dimensions

Read `agent-constraints/code-conformance-dimensions.md` at the repo root for the
review criteria specific to this repository. If it does not exist, evaluate
across the default dimensions: plan completeness, scope adherence, file
coverage, DDD conformance, testing coverage, risk mitigation, and convention
compliance.

## Step 5: Record the Review

Write the verification to an issue-scoped YAML file:

```yaml
# /tmp/conformance-issue-<N>.yaml
steps:
  - order: 1
    status: implemented
    description: "Added CompositeKey value object in src/domain/data/composite_key.ts"
  - order: 2
    status: deviated
    description: "Used existing parseKey helper instead of creating new parser"
    justification: "parseKey already handles all the cases step 2 described"
  - order: 3
    status: missing
    description: "Integration test for cross-repo queries was not added"
  - order: 100
    status: added
    description: "Fixed typo in adjacent error message"
    justification: "One-character fix in the same file — trivial scope addition"
```

Then record it:

```
swamp model @swamp/issue-lifecycle method run code_conformance_review issue-<N> \
  --input-file /tmp/conformance-issue-<N>.yaml
```

Use order numbers 100+ for `added` steps (unplanned changes) to distinguish them
from plan steps.

## Step 6: Present to the Human

Show the verification results grouped by status:

1. Missing steps (need explanation)
2. Deviated steps without justification (need explanation)
3. Deviated steps with justification (for awareness)
4. Added steps without justification (need explanation)
5. Implemented steps (for completeness)

If there are unjustified deviations, say:

> "The code conformance review found N deviation(s) from the plan that need
> justification before we can create a PR. Here's what differs: ..."

If all deviations are justified, say:

> "Code conformance review complete — all deviations from the plan are
> justified. Ready to create a PR when you are."

## Step 7: Justify Remaining Deviations

When the human explains a deviation, record the justification:

```yaml
# /tmp/justifications-issue-<N>.yaml
justifications:
  - order: 3
    justification: "Decided to defer cross-repo integration tests to a follow-up issue"
```

```
swamp model @swamp/issue-lifecycle method run justify_deviations issue-<N> \
  --input-file /tmp/justifications-issue-<N>.yaml
```

Keep iterating until all deviations are justified. Only then can `link_pr`
proceed.

## Next Phase

All deviations justified. Read [implementation.md](implementation.md) step 4
onward to create and link the PR.
