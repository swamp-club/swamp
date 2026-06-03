# Planning Conventions

## DDD Analysis

Every plan must include a DDD analysis identifying domain concepts, entities,
and services affected by the change. Use the `ddd` skill for guidance.

## Documentation Impact

Before presenting the plan, evaluate whether the change affects anything
described in `design/*.md` or `.claude/skills/`. If so, include explicit plan
steps to update those files. Common triggers: new domain concepts, changed CLI
commands or flags, new extension patterns, modified architectural decisions,
renamed types or methods referenced in skill examples.

## User Acceptance Testing (UAT) Assessment

Evaluate whether the change requires end-to-end UAT coverage in the
`swamp-club/swamp-uat` repo. That repo has two categories of tests:

- **CLI UAT tests** (`tests/cli/`) — verify CLI commands, flags, and output from
  a user's perspective. File paths mirror CLI command paths (e.g.
  `swamp model create` → `tests/cli/model/create_test.ts`).
- **Adversarial tests** (`tests/cli/adversarial/`) — verify robustness under
  edge conditions: concurrency, resource exhaustion, security boundaries, state
  corruption, process lifecycle.

First, check if existing UAT coverage exists:

```
gh api repos/swamp-club/swamp-uat/contents/tests/cli --jq '.[].name'
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
  gh issue create --repo swamp-club/swamp-uat \
    --title "UAT: <describe the missing test scenario>" \
    --body "<reproduction steps, expected behavior, which CLI commands to test>"
  ```
  Use the label `cli` for CLI UAT gaps or `adversarial` for adversarial test
  gaps.
- Include UAT assessment findings when presenting the plan to the human.

## Manual Documentation Assessment

Evaluate whether the change requires updates to the user-facing documentation in
the `swamp-club/swamp-club` repo under `content/manual/`. That directory follows
the Diátaxis framework:

- **How-to guides** (`content/manual/how-to/`) — task-oriented guides (e.g.
  creating and publishing extensions).
- **Reference** (`content/manual/reference/`) — technical descriptions of CLI
  commands, configuration, schemas, and APIs (e.g. CEL expressions, model
  definitions, workflows, vaults, datastores).
- **Explanation** (`content/manual/explanation/`) — conceptual overviews (e.g.
  how swamp works, AI agent integration).
- **Tutorials** (`content/manual/tutorials/`) — learning-oriented walkthroughs
  (e.g. hello-world).

First, check what documentation exists:

```
gh api repos/swamp-club/swamp-club/contents/content/manual/reference --jq '.[].name'
gh api repos/swamp-club/swamp-club/contents/content/manual/how-to --jq '.[].name'
gh api repos/swamp-club/swamp-club/contents/content/manual/explanation --jq '.[].name'
gh api repos/swamp-club/swamp-club/contents/content/manual/tutorials --jq '.[].name'
```

Then assess:

- If the change **is purely internal** (refactors, internal API changes, test
  improvements) with no user-visible behavior change → no docs action needed.
  State this when presenting the plan.
- If the change **adds a new user-facing feature** (new CLI command, new flag,
  new extension pattern, new configuration option) and no existing doc covers it
  → flag this to the human.
- If the change **modifies existing user-facing behavior** (changed CLI output,
  renamed flags, altered configuration schema, changed defaults) and an existing
  doc describes the old behavior → flag the stale doc to the human.
- If the change **deprecates or removes a feature** documented in the manual →
  flag the doc that needs updating or removal.
- If the human agrees a documentation gap exists, file an issue in `swamp-club`:
  ```
  gh issue create --repo swamp-club/swamp-club \
    --title "Docs: <describe the documentation gap>" \
    --body "<what changed, which manual page needs updating, suggested content>"
  ```
  Use the label `documentation` for doc gaps.
- Include documentation assessment findings when presenting the plan to the
  human.
