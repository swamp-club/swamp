---
name: issue-lifecycle
description: >
  Drive the @si/issue-lifecycle model for interactive issue triage and
  plan iteration. Use when the user wants to triage a GitHub issue,
  generate an implementation plan, or iterate on a plan with feedback.
  Triggers on "triage issue", "triage #", "issue plan", "review plan",
  "iterate plan", "approve plan", "issue lifecycle", "fix review issues",
  "check CI", "ci status".
---

# Issue Lifecycle Skill

Interactive triage and implementation planning for GitHub issues using the
`@si/issue-lifecycle` extension model. This skill drives the model
conversationally — the human steers, you execute.

## Core Principle

**Never auto-approve.** Always stop and show the plan to the human. Always ask
for feedback. Only call `approve` when the human explicitly says to proceed.

## Starting a New Triage

When the user says something like "triage issue #850" or "triage
systeminit/swamp#850":

1. **Create the model instance** (if it doesn't already exist):
   ```
   swamp model create @si/issue-lifecycle issue-<N> \
     --global-arg issueNumber=<N> --json
   ```
   The repo defaults to `systeminit/swamp`. Override with
   `--global-arg repo=<owner/repo>` for other repositories.

2. **Fetch the issue context**:
   ```
   swamp model method run issue-<N> start
   ```

3. **Read the issue context** from the model output, then **read the codebase**:
   - Read `CLAUDE.md` and `design/*.md`
   - Read relevant skills (especially `ddd/SKILL.md`)
   - Explore source files related to the issue
   - Trace code paths to understand the problem

4. **Classify the issue** based on your analysis:
   ```
   swamp model method run issue-<N> triage \
     --input type=<bug|feature|unclear> \
     --input confidence=<high|medium|low> \
     --input reasoning="<your analysis>"
   ```

5. **Generate an implementation plan**:

   First, write a single YAML file (e.g. `/tmp/plan.yaml`) containing both
   `steps` and `potentialChallenges` as top-level keys. The CLI only supports
   one `--input-file` flag per invocation, and the file must be a YAML object
   (not a bare array).

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

6. **Check for documentation impact.** Before presenting the plan, evaluate
   whether the change affects anything described in `design/*.md` or
   `.claude/skills/`. If so, include explicit plan steps to update those files.
   Common triggers: new domain concepts, changed CLI commands or flags, new
   extension patterns, modified architectural decisions, renamed types or
   methods referenced in skill examples.

7. **Show the plan to the human**, then **run adversarial review** (see below).

## Adversarial Plan Review

After **every** `plan` or `iterate` call, you MUST run an adversarial review
before the human can approve. This is automatic — do not skip it.

### Step 1: Challenge the plan

Re-read the plan, then critically evaluate it across these dimensions:

- **Architecture**: Does this follow DDD principles? Are domain boundaries
  correct? Is this the right abstraction level? Are there better patterns?
- **Scope**: Is this doing too much or too little? Does it match the issue? Is
  there scope creep? Are there unnecessary changes?
- **Risk**: Are all failure modes identified? What about edge cases, race
  conditions, backwards compatibility? What could go wrong that isn't listed?
- **Testing**: Is the testing strategy sufficient? Are edge cases covered? Are
  there integration test gaps? Is there over-reliance on unit tests?
- **Complexity**: Is this over-engineered? Could it be simpler? Are there
  unnecessary abstractions or indirections?
- **Correctness**: Will this actually solve the problem? Are there logical gaps?
  Does the approach match established patterns in the codebase?
- **Documentation**: Does this change introduce or modify domain concepts, CLI
  commands, extension patterns, or architectural decisions that should be
  reflected in `design/*.md` or `.claude/skills/`? If a design doc describes
  behavior this plan changes, the plan must include a step to update it. If a
  skill references CLI commands or examples affected by this change, the plan
  must include a step to update the skill. Flag any gaps as findings.

### Step 2: Verify against the codebase

For each plan step, **read the actual code**:

- Read every file referenced in the plan steps — verify they exist
- Confirm functions, classes, and types exist where claimed
- Grep for related code the plan might have missed
- Check for conflicts with existing patterns or naming conventions
- Verify that proposed test paths and test patterns match the codebase
- Look for code that already does what a step proposes (duplication risk)
- Check if design docs in `design/` describe behavior being changed — flag stale
  docs
- Check if skills in `.claude/skills/` reference commands, flags, or examples
  affected by the plan — flag stale skills

### Step 3: Record findings

Write findings to a YAML file (e.g. `/tmp/findings.yaml`) as a YAML object with
a `findings` key:

```yaml
# /tmp/findings.yaml
findings:
  - id: ADV-1
    severity: high
    category: architecture
    description: "The plan adds a new service but doesn't define its domain boundary"
  - id: ADV-2
    severity: medium
    category: testing
    description: "No integration tests planned for the new API endpoint"
```

Then record them:

```
swamp model method run issue-<N> adversarial_review \
  --input-file /tmp/findings.yaml
```

Each finding must have:

- `id`: Sequential identifier (ADV-1, ADV-2, ...)
- `severity`: critical, high, medium, or low
- `category`: architecture, scope, risk, testing, complexity, correctness, or
  documentation
- `description`: Clear explanation of the concern

**Critical/high findings block approval.** Medium/low are shown as warnings.

### Step 4: Present to the human

Show findings grouped by severity:

1. Critical findings (blockers)
2. High findings (blockers)
3. Medium findings (warnings)
4. Low findings (warnings)

If there are blocking findings, say:

> "The adversarial review found N blocking issue(s) that need to be addressed
> before approval. Here's what needs to change: ..."

If no blocking findings, say:

> "Adversarial review passed — no blocking findings. N warning(s) noted. Ready
> for your approval when you are."

## Plan Iteration Loop

When the human gives feedback OR adversarial findings need addressing:

1. **Call iterate** with both the feedback text and your revised plan. Write the
   revised `steps` and `potentialChallenges` to a YAML file (same format as the
   `plan` step above), then run:

   ```
   swamp model method run issue-<N> iterate \
     --input feedback="<human's feedback or adversarial findings>" \
     --input summary="..." \
     --input dddAnalysis="..." \
     --input testingStrategy="..." \
     --input-file /tmp/plan.yaml
   ```

2. **Resolve addressed findings**. Write resolutions to a YAML file:

   ```yaml
   # /tmp/resolutions.yaml
   resolutions:
     - findingId: ADV-1
       resolutionNote: "Added domain boundary definition in step 2"
     - findingId: ADV-2
       resolutionNote: "Added integration test step covering the new endpoint"
   ```

   ```
   swamp model method run issue-<N> resolve_findings \
     --input-file /tmp/resolutions.yaml
   ```

3. **Re-run adversarial review** on the new plan version. The review must be
   current with the latest plan version — stale reviews block approval.

4. **Show what changed** between the previous and new plan version. Be specific:
   - "Reordered steps 2 and 3 based on your feedback"
   - "Added regression analysis for module X"
   - "Removed step 4 — you're right, that's already handled by..."

5. **Ask for feedback again.** Keep iterating until:
   - All critical/high adversarial findings are resolved, AND
   - The human says: "approve", "approved", "looks good", "ship it", "go",
     "LGTM"

6. Only then call `approve`:
   ```
   swamp model method run issue-<N> approve
   ```

**The `approve` method will fail** if critical/high findings are unresolved or
if the adversarial review is stale (wrong plan version). This is enforced by the
`adversarial-review-clear` pre-flight check.

## Implementation & CI Flow

After plan approval, when the human says to implement:

1. **Do the implementation work** based on the approved plan
2. **Create a PR** using the `github-pr` skill
3. **Record the PR number**:
   ```
   swamp model method run issue-<N> implement \
     --input prNumber=<N>
   ```

4. **Wait 3 minutes for CI to start.** Use `sleep 180` — CI takes at least this
   long, so there's no point polling earlier.

5. **Poll for CI results.** Call `ci_status` and check if checks are still
   pending. If pending, wait 60 seconds and retry. Keep polling until all checks
   have completed (passed or failed). Do NOT hand control back to the human
   during this wait — stay in the loop.

   ```
   swamp model method run issue-<N> ci_status
   ```

6. **Show the CI results** to the human, grouped by reviewer and severity:
   - Which checks passed/failed
   - Review comments grouped by reviewer
   - Comments sorted by severity (critical first)

7. **If everything is green and approved**, the PR will auto-merge. Call
   `complete` immediately — no need to ask the human:
   ```
   swamp model method run issue-<N> complete
   ```

8. **If there are failures or review comments**, present them and wait for the
   human's direction. Parse their instruction:
   - "fix the CRITICAL issues from adversarial review" ->
     `targetReview: "claude-adversarial-review"`, `targetSeverity: "critical"`
   - "address all the review comments" -> no filters
   - "fix the test failures" -> `targetReview: "test"`

   ```
   swamp model method run issue-<N> fix \
     --input directive="<human's instruction>" \
     --input targetReview="<reviewer>" \
     --input targetSeverity="<severity>"
   ```

9. **After pushing fixes, loop back to step 4.** Wait 3 minutes, poll for CI,
   show results. Repeat until clean or the human says to stop.

**IMPORTANT:** Do not break out of this loop voluntarily. The human should never
have to manually check CI or come back to ask "what happened?" — the skill stays
in the conversation and drives through to completion. If the human wants to
break out (e.g. "I'll come back to this later", "pause", "stop"), respect that
immediately — but it must be their decision, never yours.

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

Then pick up from whatever phase the state shows. The full history of plans,
feedback, and CI results is persisted in the model data.

## Key Rules

1. **Never skip the feedback loop.** Always show the plan. Always ask.
2. **Never call approve without explicit human approval.**
3. **Persist everything through the model.** Don't just have a conversation —
   call the model methods so state survives context compression and sessions.
4. **GitHub comments are automatic.** Every state transition posts to the issue.
   You don't need to manually post comments.
5. **Read the codebase thoroughly** before generating the plan. The plan should
   reference specific files, functions, and test paths.
6. **Use DDD analysis.** Every plan should identify domain concepts, entities,
   and services affected by the change.
