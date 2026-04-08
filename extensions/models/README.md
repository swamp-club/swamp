# Issue Lifecycle Extension Model

The `@swamp/issue-lifecycle` extension model drives interactive issue triage and
implementation planning against swamp-club lab issues. Every plan revision,
feedback round, and adversarial finding is stored as versioned, immutable data,
and every state transition is mirrored to swamp-club as a structured lifecycle
entry.

## Why

Plans are revised in seconds. State is persisted in swamp's data store so you
can walk away and resume later. swamp-club is the single source of truth for the
issue itself — the model fetches the issue by number, classifies it, plans it,
and reports progress back to swamp-club on every transition.

## State Machine

```
created ──[start]──> triaging
triaging ──[triage]──> classified
classified ──[plan]──> plan_generated
plan_generated ──[iterate]──> plan_generated  (feedback loop)
plan_generated ──[approve]──> approved
approved ──[implement]──> implementing
implementing ──[complete]──> done
```

Pre-flight checks enforce valid transitions. You cannot approve without a plan.
You cannot approve with unresolved critical/high adversarial findings. You
cannot implement without approval.

## Using with Claude Code (recommended)

Tell Claude:

```
triage swamp-club issue #42
```

The `issue-lifecycle` skill takes over. Claude creates the model instance,
fetches the issue from swamp-club, reads the codebase, classifies the issue,
generates a plan, and shows it to you.

From there, it's a conversation: revise the plan, run adversarial review,
iterate until you approve, then implement and complete.

## Using via CLI (manual mode)

If you want to drive the model directly without Claude:

### Setup

```bash
# Create an instance for swamp-club issue #42
swamp model create @swamp/issue-lifecycle issue-42 \
  --global-arg issueNumber=42 --json
```

### Triage

```bash
# Fetch issue context from swamp-club
swamp model method run issue-42 start --json

# Classify the issue (updates the swamp-club type)
swamp model method run issue-42 triage \
  --input type=bug \
  --input confidence=high \
  --input isRegression=true \
  --input reasoning="Parser fails on nested brackets — regression from #38" --json

# Generate a plan
swamp model method run issue-42 plan \
  --input summary="Fix bracket parsing in tokenizer" \
  --input dddAnalysis="Touches the Parser entity..." \
  --input testingStrategy="Unit tests for tokenizer edge cases" \
  --input-file /tmp/plan.yaml --json
```

### Plan iteration

```bash
# Review the current plan
swamp model method run issue-42 review --json

# Review a specific version
swamp model method run issue-42 review --input version=1 --json

# Submit feedback and a revised plan
swamp model method run issue-42 iterate \
  --input feedback="Step ordering is wrong" \
  --input summary="..." \
  --input dddAnalysis="..." \
  --input testingStrategy="..." \
  --input-file /tmp/plan.yaml --json

# Record adversarial findings (required before approve)
swamp model method run issue-42 adversarial_review \
  --input-file /tmp/findings.yaml --json

# Mark findings resolved after revising the plan
swamp model method run issue-42 resolve_findings \
  --input-file /tmp/resolutions.yaml --json

# Approve when all critical/high findings are resolved
swamp model method run issue-42 approve --json
```

### Implementation

```bash
# Signal implementation has started
swamp model method run issue-42 implement --json

# Mark done once the PR is merged
swamp model method run issue-42 complete --json
```

### Inspection

```bash
# See current state
swamp model get issue-42 --json

# See all stored data (plans, feedback, adversarial findings)
swamp model output search issue-42 --json
```

## Methods

| Method               | Description                                     | State Transition                 |
| -------------------- | ----------------------------------------------- | -------------------------------- |
| `start`              | Fetch issue from swamp-club                     | \* -> triaging                   |
| `triage`             | Classify as bug/feature/security                | triaging -> classified           |
| `plan`               | Generate implementation plan                    | classified -> plan_generated     |
| `review`             | Display current plan (read-only)                | no change                        |
| `iterate`            | Revise plan with feedback                       | plan_generated -> plan_generated |
| `adversarial_review` | Record adversarial review findings for the plan | no change                        |
| `resolve_findings`   | Mark adversarial findings as resolved           | no change                        |
| `approve`            | Lock the plan and transition to in_progress     | plan_generated -> approved       |
| `implement`          | Signal implementation started                   | approved -> implementing         |
| `complete`           | Mark lifecycle done                             | implementing -> done             |

## Data stored

All data is versioned and immutable. Each `iterate` creates a new plan version
and a new feedback version. You can review any prior version.

| Resource            | What it stores                                |
| ------------------- | --------------------------------------------- |
| `state`             | Current phase and swamp-club issue number     |
| `context`           | Issue title, body, type, status, comments     |
| `classification`    | bug/feature/security + reasoning + regression |
| `plan`              | Implementation plan (versioned per iteration) |
| `feedback`          | Human feedback (versioned per round)          |
| `adversarialReview` | Adversarial review findings for current plan  |

## Swamp Club Integration

The issue-lifecycle model operates directly on swamp-club lab issues. There is
no GitHub integration — create the issue in swamp-club first, then pass the
sequential lab number (e.g. `42`) as the `issueNumber` global arg.

### How it works

Every state transition (triage, plan, approve, implement, complete) posts a
structured lifecycle entry to the swamp-club API and transitions the issue's
status. The `triage` method additionally PATCHes the issue's `type` field to
match the classification.

Each lab issue has a sequential, human-friendly number (`#1`, `#2`, ...) used in
every lab URL — both the dashboard and the API. You can find an issue at
`https://swamp.club/lab/<number>`.

Classification types (`triage`) match swamp-club's issue types:

| Classification | swamp-club type |
| -------------- | --------------- |
| `bug`          | bug             |
| `feature`      | feature         |
| `security`     | security        |

Regressions are classified as `type: bug` with `isRegression: true` on the
classification record — swamp-club does not have a separate `regression` type.

Status transitions in swamp-club:

| Method     | swamp-club status |
| ---------- | ----------------- |
| `start`    | open              |
| `triage`   | triaged           |
| `approve`  | in_progress       |
| `complete` | shipped           |

### Setup

The model requires a swamp-club API key. The URL defaults to
`https://swamp.club`.

**Option 1: Environment variable (recommended)**

```bash
export SWAMP_API_KEY=swamp_your_key_here
```

The model reads `SWAMP_API_KEY` automatically and connects to
`https://swamp.club`.

**Option 2: Point at a local dev server**

```bash
export SWAMP_API_KEY=swamp_your_key_here
export SWAMP_CLUB_URL=http://localhost:8000
```

**Option 3: Global args on `swamp model create`**

```bash
swamp model create @swamp/issue-lifecycle issue-42 \
  --global-arg issueNumber=42 \
  --global-arg swampClubUrl=http://localhost:8000 \
  --global-arg swampClubApiKey=swamp_your_key_here --json
```

If no credentials are available, `start` fails immediately — swamp-club is
mandatory.

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

- swamp initialized in the repository (`swamp init`)
- `SWAMP_API_KEY` env var (or `swamp auth login`) for swamp-club access
- The target lab issue must already exist in swamp-club
