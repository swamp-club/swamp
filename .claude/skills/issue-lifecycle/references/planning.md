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

## 7. Apply Repo-Specific Planning Conventions

Read `agent-constraints/planning-conventions.md` at the repo root for
repo-specific planning requirements (documentation checks, test strategy,
analysis conventions, UAT assessment). If it does not exist, generate the plan
based on your codebase analysis and CLAUDE.md conventions.

## 8. Present the Plan

Show the plan to the human, then run adversarial review (see
[adversarial-review.md](adversarial-review.md)).
