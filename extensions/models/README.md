# Issue Lifecycle Extension Model

The `@swamp/issue-lifecycle` extension model moves GitHub issue triage and
implementation planning out of GitHub Actions and into a local, interactive
workflow. Every plan revision, feedback round, and CI result is stored as
versioned, immutable data — the issue thread on GitHub becomes a live status
dashboard.

## Why

The old flow: a `/triage` comment in GitHub triggers a CI action, Claude posts a
plan as a comment, you push back in the comment thread, re-triage, wait for CI,
repeat. Every round-trip goes through GitHub's API and Actions queue.

The new flow: triage happens locally in a conversation with Claude. You push
back directly. Plans are revised in seconds, not minutes. State is persisted in
swamp's data store so you can walk away and resume later. GitHub gets a comment
on every state change so the issue thread stays current.

## State Machine

```
created ──[start]──> triaging
triaging ──[triage]──> classified
classified ──[plan]──> plan_generated
plan_generated ──[iterate]──> plan_generated  (feedback loop)
plan_generated ──[approve]──> approved
approved ──[implement]──> implementing
implementing ──[ci_status]──> ci_review
ci_review ──[fix]──> implementing  (fix loop)
ci_review ──[complete]──> done
```

Two iteration loops:

1. **Plan loop** — generate a plan, get feedback, revise, repeat until approved
2. **Fix loop** — check CI, direct fixes, push, check CI again until clean

Pre-flight checks enforce valid transitions. You cannot approve without a plan.
You cannot implement without approval.

## Using with Claude Code (recommended)

Tell Claude:

```
triage issue #850
```

The `issue-lifecycle` skill takes over. Claude creates the model instance,
fetches the issue from GitHub, reads the codebase, classifies the issue,
generates a plan, and shows it to you.

From there, it's a conversation:

```
You:    The step ordering is wrong — CLI should come before parser changes.
        What about regressions in the tokenizer?

Claude: [revises plan, persists feedback]
        Revised plan (v2):
        1. Update CLI command ...
        2. Add parser validation ...
        3. Regression tests for tokenizer ...
        Feedback?

You:    Looks good. Approve it.

Claude: [approves, posts full plan to GitHub issue]
        Plan approved. Ready to implement?

You:    Go.

Claude: [implements, creates PR, records PR number]
        PR #851 created. Checking CI...

        CI Results:
        - test: PASSED
        - claude-review: CHANGES_REQUESTED (1 critical)
        - adversarial-review: APPROVED

You:    Fix the critical issue from claude-review.

Claude: [persists fix directive, makes fix, pushes, checks CI again]
        All checks passed. Ship it?

You:    Done.

Claude: [marks complete, posts to GitHub]
```

Every step posts a comment to the GitHub issue. Anyone watching sees:

- "Triage started"
- "Classified as bug (high confidence)"
- "Plan revised (v2) — incorporated feedback round 1"
- "Plan approved (v2)" with the full plan
- "Implementation started — PR #851"
- "CI results: 4 passed, 1 failed"
- "Fixing: critical issue from claude-review"
- "Complete — all checks passed"

## Using via CLI (manual mode)

If you want to drive the model directly without Claude:

### Setup

```bash
# Create an instance for issue #850
swamp model create @swamp/issue-lifecycle issue-850 \
  --global-arg issueNumber=850 \
  --global-arg repo=owner/repo --json
```

### Triage

```bash
# Fetch issue context from GitHub
swamp model method run issue-850 start --json

# Classify the issue
swamp model method run issue-850 triage \
  --input type=bug \
  --input confidence=high \
  --input reasoning="Parser fails on nested brackets" --json

# Generate a plan
swamp model method run issue-850 plan \
  --input summary="Fix bracket parsing in tokenizer" \
  --input dddAnalysis="Touches the Parser entity..." \
  --input-file steps.json \
  --input testingStrategy="Unit tests for tokenizer edge cases" \
  --input-file potentialChallenges.json --json
```

### Plan iteration

```bash
# Review the current plan
swamp model method run issue-850 review --json

# Review a specific version
swamp model method run issue-850 review --input version=1 --json

# Submit feedback and a revised plan
swamp model method run issue-850 iterate \
  --input feedback="Step ordering is wrong" \
  --input summary="..." \
  --input-file steps.json \
  --input testingStrategy="..." \
  --input-file potentialChallenges.json --json

# Approve when satisfied
swamp model method run issue-850 approve --json
```

### Implementation & CI

```bash
# Record PR number (approve already marked work as in-progress)
swamp model method run issue-850 implement --input prNumber=851 --json

# Fetch CI results
swamp model method run issue-850 ci_status --json

# Direct fixes
swamp model method run issue-850 fix \
  --input directive="Fix the CRITICAL issues from adversarial review" \
  --input targetReview=claude-adversarial-review \
  --input targetSeverity=critical --json

# Check CI again
swamp model method run issue-850 ci_status --json

# Mark done
swamp model method run issue-850 complete --json
```

### Inspection

```bash
# See current state
swamp model get issue-850 --json

# See all stored data (plans, feedback, CI results)
swamp model output search issue-850 --json
```

## Methods

| Method               | Description                                     | State Transition                 |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| `start`              | Fetch issue from GitHub                         | \* -> triaging                   |
| `triage`             | Classify as bug/feature/unclear                 | triaging -> classified           |
| `plan`               | Generate implementation plan                    | classified -> plan_generated     |
| `review`             | Display current plan (read-only)                | no change                        |
| `iterate`            | Revise plan with feedback                       | plan_generated -> plan_generated |
| `adversarial_review` | Record adversarial review findings for the plan | no change                        |
| `resolve_findings`   | Mark adversarial findings as resolved           | no change                        |
| `approve`            | Lock the plan, post to GitHub, start work       | plan_generated -> approved       |
| `implement`          | Signal implementation started                   | approved -> implementing         |
| `record_pr`          | Record PR number for CI tracking                | implementing -> implementing     |
| `ci_status`          | Fetch CI check results and review comments      | implementing -> ci_review        |
| `fix`                | Direct specific fixes from review feedback      | ci_review -> implementing        |
| `complete`           | Mark lifecycle done                             | ci_review -> done                |

## Data stored

All data is versioned and immutable. Each `iterate` creates a new plan version
and a new feedback version. You can review any prior version.

| Resource            | What it stores                                |
| ------------------- | --------------------------------------------- |
| `state`             | Current phase, repo, issue number, PR number  |
| `context`           | Issue title, body, labels, comments           |
| `classification`    | Bug/feature/unclear + reasoning               |
| `plan`              | Implementation plan (versioned per iteration) |
| `feedback`          | Human feedback (versioned per round)          |
| `adversarialReview` | Adversarial review findings for current plan  |
| `ciResults`         | CI check runs + review comments               |
| `fixDirective`      | Human-directed fix instructions               |

## Swamp Club Integration

The issue-lifecycle model can optionally push structured lifecycle data to
[swamp.club](https://swamp.club), giving you a dashboard view of issue progress
across your team.

### How it works

Every state transition (triage, plan, approve, implement, complete) posts a
structured lifecycle entry to the swamp-club API. The issue is created in
swamp-club on first contact via the `/ensure` endpoint, which matches by GitHub
repo + issue number.

Key status transitions in swamp-club:

| Method     | swamp-club status |
| ---------- | ----------------- |
| `start`    | open              |
| `triage`   | triaged           |
| `approve`  | in_progress       |
| `complete` | shipped           |

### Setup

The integration requires a swamp-club API key. The URL defaults to
`https://swamp.club`.

**Option 1: Environment variable (recommended)**

```bash
export SWAMP_API_KEY=swamp_your_key_here
```

That's it. The model reads `SWAMP_API_KEY` automatically and connects to
`https://swamp.club`.

**Option 2: Point at a local dev server**

```bash
export SWAMP_API_KEY=swamp_your_key_here
export SWAMP_CLUB_URL=http://localhost:8000
```

If no API key is set, the swamp-club integration is silently disabled — all
GitHub comment posting and local data storage still works normally.

## Repository Configuration

The embedded skill reads repo-specific conventions from `agent-constraints/` at
the repository root. These files customize how triage, planning, adversarial
review, and implementation work in your repository:

| File                            | What it controls                            |
| ------------------------------- | ------------------------------------------- |
| `adversarial-dimensions.md`     | Review criteria and dimensions              |
| `planning-conventions.md`       | Analysis requirements, documentation checks |
| `triage-conventions.md`         | Codebase exploration and bug reproduction   |
| `implementation-conventions.md` | Build, verification, and PR conventions     |

All files are optional. If they do not exist, the skill uses generic defaults.
Create only the files you want to customize.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth login`)
- swamp initialized in the repository (`swamp init`)
- (Optional) `SWAMP_API_KEY` env var for swamp-club integration
