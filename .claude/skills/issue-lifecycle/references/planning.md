# Planning Phase

Steps 6–9 of the issue lifecycle. Read this after triage is complete and you're
ready to generate an implementation plan.

## 6. Generate an Implementation Plan

Write a single YAML file (e.g. `/tmp/plan.yaml`) containing both `steps` and
`potentialChallenges` as top-level keys. The CLI only supports one
`--input-file` flag per invocation, and the file must be a YAML object (not a
bare array).

```yaml
# /tmp/plan.yaml
steps:
  - order: 1
    description: "Add the new schema types"
    files:
      - src/domain/schemas.ts
    risks: "May need migration"
  - order: 2
    description: "Update the service layer"
    files:
      - src/domain/service.ts
      - src/domain/service_test.ts
potentialChallenges:
  - "Backwards compatibility with existing data"
  - "Test coverage for edge cases"
```

Then run the method. The `--input` flags handle scalar values, and
`--input-file` handles the structured data:

```
swamp model method run issue-<N> plan \
  --input summary="..." \
  --input dddAnalysis="..." \
  --input testingStrategy="..." \
  --input-file /tmp/plan.yaml
```

## 7. Check for Documentation Impact

Before presenting the plan, evaluate whether the change affects anything
described in `design/*.md` or `.claude/skills/`. If so, include explicit plan
steps to update those files. Common triggers: new domain concepts, changed CLI
commands or flags, new extension patterns, modified architectural decisions,
renamed types or methods referenced in skill examples.

## 8. Assess User Acceptance Testing (UAT) Impact

Evaluate whether the change requires end-to-end UAT coverage in the
`systeminit/swamp-uat` repo. That repo has two categories of tests:

- **CLI UAT tests** (`tests/cli/`) — verify CLI commands, flags, and output from
  a user's perspective. File paths mirror CLI command paths (e.g.
  `swamp model create` → `tests/cli/model/create_test.ts`).
- **Adversarial tests** (`tests/cli/adversarial/`) — verify robustness under
  edge conditions: concurrency, resource exhaustion, security boundaries, state
  corruption, process lifecycle.

First, check if existing UAT coverage exists:

```
gh api repos/systeminit/swamp-uat/contents/tests/cli --jq '.[].name'
```

Then assess:

- If the change **is purely internal** (refactors, internal API changes) or
  already covered by unit/integration tests in the swamp repo → no UAT action
  needed. State this when presenting the plan.
- If the change **affects user-facing CLI behavior** (commands, flags, output
  formats) and no existing CLI UAT test covers it → flag this to the human.
- If the change **affects robustness, error handling, or edge-case behavior**
  (concurrency, large inputs, process signals, security boundaries) and no
  existing adversarial test covers it → flag this to the human.
- If the human agrees a UAT gap exists, file an issue in `swamp-uat`:
  ```
  gh issue create --repo systeminit/swamp-uat \
    --title "UAT: <describe the missing test scenario>" \
    --body "<reproduction steps, expected behavior, which CLI commands to test>"
  ```
  Use the label `cli` for CLI UAT gaps or `adversarial` for adversarial test
  gaps.
- Include UAT assessment findings when presenting the plan to the human.

## 9. Present the Plan

Show the plan to the human, then run adversarial review (see
[adversarial-review.md](adversarial-review.md)).
