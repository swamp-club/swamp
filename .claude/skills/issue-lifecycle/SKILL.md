---
name: issue-lifecycle
description: >
  Drive the @swamp/issue-lifecycle model for interactive issue triage and
  plan iteration. Use when the user wants to triage a GitHub issue,
  generate an implementation plan, or iterate on a plan with feedback.
  Triggers on "triage issue", "triage #", "issue plan", "review plan",
  "iterate plan", "approve plan", "issue lifecycle", "fix review issues",
  "check CI", "ci status".
---

# Issue Lifecycle Skill

Interactive triage and implementation planning for GitHub issues using the
`@swamp/issue-lifecycle` extension model. This skill drives the model
conversationally — the human steers, you execute.

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
fetching issue context, reading the codebase, classifying the issue, and
reproducing bugs.

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

### Phase 4: Implementation & CI

Read [references/implementation.md](references/implementation.md) after plan
approval. Covers: doing the work, verifying fixes against the reproduction,
creating the PR, CI polling loop, handling failures, and completing the issue.

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

If the human comes back to an in-progress issue, check the current state:

```
swamp model get issue-<N> --json
```

Then read the reference file for whatever phase the state shows and pick up from
there.

## Key Rules

1. **Never skip the feedback loop.** Always show the plan. Always ask.
2. **Never call approve without explicit human approval.**
3. **Persist everything through the model.** Don't just have a conversation —
   call the model methods so state survives context compression and sessions.
4. **GitHub comments are automatic.** Every state transition posts to the issue.
   You don't need to manually post comments.
5. **Read the codebase thoroughly** before generating the plan. The plan should
   reference specific files, functions, and test paths.
6. **Follow the planning conventions for this repository.** Read
   `agent-constraints/planning-conventions.md` if it exists.
7. **File unrelated issues immediately.** If you discover a bug, code smell, or
   problem during investigation that is NOT related to the current issue, file
   it as a new GitHub issue in the current repository. Do not try to fix it in
   the current work span — keep the scope focused.
