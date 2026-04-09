---
name: issue-lifecycle
description: >
  Drive the @swamp/issue-lifecycle model for interactive issue triage and
  plan iteration against swamp-club lab issues. Use when the user wants to
  triage a swamp-club issue, generate an implementation plan, or iterate on
  a plan with feedback. Triggers on "triage issue", "triage #", "issue plan",
  "review plan", "iterate plan", "approve plan", "issue lifecycle".
---

# Issue Lifecycle Skill

Interactive triage and implementation planning for swamp-club lab issues using
the `@swamp/issue-lifecycle` extension model. This skill drives the model
conversationally — the human steers, you execute.

The model operates on swamp-club lab issue numbers. Every step records a
structured lifecycle entry against the issue in swamp-club and transitions its
status as the work progresses. There is no GitHub integration — the issue must
already exist in swamp-club before you start.

## Core Principle

**Never auto-approve.** Always stop and show the plan to the human. Always ask
for feedback. Only call `approve` when the human explicitly says to proceed.

## Repository Configuration

This skill reads repo-specific conventions from `agent-constraints/` at the
repository root. If these files exist, they customize how each phase works:

- `agent-constraints/adversarial-dimensions.md` — review criteria and dimensions
- `agent-constraints/planning-conventions.md` — analysis and documentation
  requirements
- `agent-constraints/triage-conventions.md` — codebase exploration and bug
  reproduction
- `agent-constraints/implementation-conventions.md` — build, verify, and PR
  conventions

If these files do not exist, the skill uses generic defaults documented in each
reference file.

## Lifecycle Phases

Each phase has detailed instructions in a reference file. Read only the
reference you need for the current phase.

### Phase 1: Triage (steps 1–5)

Read [references/triage.md](references/triage.md) when starting a new triage or
resuming an issue in the `triaging` phase. Covers: creating the model instance,
fetching issue context from swamp-club, reading the codebase, classifying the
issue, and reproducing bugs.

### Phase 2: Planning (steps 6–9)

Read [references/planning.md](references/planning.md) after triage is complete.
Covers: generating the implementation plan, checking documentation impact,
assessing UAT coverage gaps, and presenting to the human.

### Phase 3: Adversarial Review & Iteration

Read [references/adversarial-review.md](references/adversarial-review.md)
**immediately after every `plan` or `iterate` call — no exceptions.** Planning
and adversarial review are always paired: you never present a plan without
running the review first. Covers: challenging the plan across repo-specific
dimensions, verifying against the codebase, recording findings, presenting to
the human, and the iteration loop until approval.

### Phase 4: Implementation

Read [references/implementation.md](references/implementation.md) after plan
approval. Covers: signalling implementation start, doing the work, verifying
fixes against the reproduction, creating the PR, and completing the issue.

## Classification Types

The `triage` method classifies issues into one of three types (matching
swamp-club):

- `bug` — something is broken or behaving incorrectly
- `feature` — a request for new functionality or enhancement
- `security` — security vulnerability or hardening work

Two additional classification details are captured in the classification record
but do NOT map to separate swamp-club types:

- `isRegression` — set to `true` when the bug previously worked. Implies
  `type: bug`. Look for signals like "this used to work", "stopped working
  after", or git history showing recent changes to the affected code.
- Low-confidence classifications — if you cannot classify the issue confidently,
  use `confidence: low` and populate `clarifyingQuestions`. Do not guess the
  type — ask the human before calling `triage`.

## Reviewing Plan History

To review a specific plan version:

```
swamp model method run issue-<N> review --input version=<V>
```

To see all model data:

```
swamp model output search issue-<N> --json
```

## Resuming a Session

If the human comes back to an in-progress issue, check the current phase:

```
swamp data get issue-<N> state-main --json
```

Read the `phase` field from the response. **Do NOT call `start` to resume** —
`start` unconditionally resets the phase to `triaging`, destroying progress.

Use this table to determine what to do next:

| Phase            | Action                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| `triaging`       | Read [references/triage.md](references/triage.md)                         |
| `classified`     | Read [references/planning.md](references/planning.md)                     |
| `plan_generated` | Read [references/adversarial-review.md](references/adversarial-review.md) |
| `approved`       | Read [references/implementation.md](references/implementation.md)         |
| `implementing`   | Link a PR with `link_pr` or call `complete`                               |
| `pr_open`        | Wait 3 min, then check PR: `pr_merged` if merged, `pr_failed` if failed   |
| `pr_failed`      | Fix the issue, then `link_pr` (new PR) or `implement` (major rework)      |
| `releasing`      | Check release build: `ship` when done, or `complete` as fallback          |
| `done`           | Nothing to do — lifecycle is complete                                     |

The canonical phase list lives in the `TRANSITIONS` constant in
`extensions/models/_lib/schemas.ts`.

## Closing Out a Shipped Issue

When a PR has already merged and the lifecycle just needs to be marked done:

1. Check the current phase:
   ```
   swamp data get issue-<N> state-main --json
   ```
2. If the phase is `implementing`, link the PR first:
   ```
   swamp model method run issue-<N> link_pr --input url=<PR URL>
   ```
3. If the phase is `pr_open`, record the merge:
   ```
   swamp model method run issue-<N> pr_merged
   ```
4. If the phase is `releasing`, ship it:
   ```
   swamp model method run issue-<N> ship
   ```
5. For quick close-out, `complete` still works from `implementing`, `pr_open`,
   or `releasing`:
   ```
   swamp model method run issue-<N> complete
   ```

## Key Rules

1. **Never skip the feedback loop.** Always show the plan. Always ask.
2. **Never call approve without explicit human approval.**
3. **Persist everything through the model.** Don't just have a conversation —
   call the model methods so state survives context compression and sessions.
4. **swamp-club is the source of truth.** Every state transition posts a
   lifecycle entry and transitions the issue status in swamp-club automatically.
   You don't need to manually update the issue.
5. **Read the codebase thoroughly** before generating the plan. The plan should
   reference specific files, functions, and test paths.
6. **Follow the planning conventions for this repository.** Read
   `agent-constraints/planning-conventions.md` if it exists.
7. **Never open a PR without asking first.** Present the changes summary and
   wait for the human to confirm before creating the pull request.
8. **File unrelated issues immediately.** If you discover a bug, code smell, or
   problem during investigation that is NOT related to the current issue, file
   it as a new swamp-club issue. Do not try to fix it in the current work span —
   keep the scope focused.
