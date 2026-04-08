# Planning Phase

Steps 6–9 of the issue lifecycle. Read this after triage is complete and you're
ready to generate an implementation plan.

## 6. Generate an Implementation Plan

Write a single YAML file containing both `steps` and `potentialChallenges` as
top-level keys. The CLI only supports one `--input-file` flag per invocation,
and the file must be a YAML object (not a bare array).

**Use an issue-scoped filename** like `/tmp/plan-issue-<N>.yaml` rather than a
generic `/tmp/plan.yaml`. Generic filenames collide with stale content left
behind by previous lifecycle sessions — the old content usually fails to `Read`
for you to overwrite, and worse, content from an unrelated issue can silently
leak into the current plan if you forget to check. Issue-scoped filenames make
resuming sessions safe and auditable.

```yaml
# /tmp/plan-issue-<N>.yaml
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
  --input-file /tmp/plan-issue-<N>.yaml
```

## 7. Apply Repo-Specific Planning Conventions

Read `agent-constraints/planning-conventions.md` at the repo root for
repo-specific planning requirements (documentation checks, test strategy,
analysis conventions, UAT assessment). If it does not exist, generate the plan
based on your codebase analysis and CLAUDE.md conventions.

## 8. Present the Plan

Show the plan to the human, then run adversarial review (see
[adversarial-review.md](adversarial-review.md)).
