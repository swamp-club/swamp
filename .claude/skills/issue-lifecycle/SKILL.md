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
   - **Check for regression signals**: If the issue describes a bug, use
     `git log` on the affected files to see if they were recently changed. Check
     if the described behavior worked in a prior version. This informs whether
     to classify as `bug` or `regression`.

4. **Classify the issue** based on your analysis:
   ```
   swamp model method run issue-<N> triage \
     --input type=<bug|feature|regression|unclear> \
     --input confidence=<high|medium|low> \
     --input reasoning="<your analysis>"
   ```

   **Classification guidance:**
   - `bug` — something is broken or behaving incorrectly
   - `feature` — a request for new functionality or enhancement
   - `regression` — a bug where something **previously worked** but is now
     broken. Look for signals like: "this used to work", "stopped working
     after", "worked in version X", references to recent changes that broke
     existing behavior, or git history showing the affected code was recently
     modified. Regressions get both `bug` and `regression` labels.
   - `unclear` — not enough information to classify confidently

5. **Reproduce the bug** (bugs and regressions only — skip for features):

   Before planning a fix, reproduce the issue in an isolated scratch repo to
   confirm the failure mode and understand it firsthand.

   a. **Ensure swamp is up to date:**
   ```
   swamp update
   ```

   b. **Create a scratch repo:**
   ```
   mkdir -p /tmp/swamp-repro-issue-<N>
   cd /tmp/swamp-repro-issue-<N>
   swamp repo init
   ```

   c. **Build a minimal reproduction.** Based on the issue description and your
   codebase analysis, create the simplest set of models and/or workflows that
   trigger the bug. Use an Agent (subagent) to do this — give it the issue
   context, the error description, and tell it to create and run a swamp
   scenario that reproduces the problem. The agent should:
   - Create model definitions and workflow YAML files
   - Create any required input data
   - Run the workflow or model method that triggers the issue
   - Capture the exact error output or incorrect behavior

   d. **Document what you observed.** Before moving to planning, record:
   - The exact commands that reproduce the issue
   - The actual output/error (copy it verbatim)
   - The expected output/behavior
   - Any differences from what the issue originally described

   e. **Keep the scratch repo.** You'll reuse it in the verification step after
   the fix is implemented. The path `/tmp/swamp-repro-issue-<N>` must survive
   until verification is complete.

   If the bug **cannot be reproduced**, note that in the plan. It may mean the
   issue description is incomplete, the bug is environment-specific, or the
   underlying code has already changed. Ask the human how to proceed.

6. **Generate an implementation plan**:

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

7. **Check for documentation impact.** Before presenting the plan, evaluate
   whether the change affects anything described in `design/*.md` or
   `.claude/skills/`. If so, include explicit plan steps to update those files.
   Common triggers: new domain concepts, changed CLI commands or flags, new
   extension patterns, modified architectural decisions, renamed types or
   methods referenced in skill examples.

8. **Show the plan to the human**, then **run adversarial review** (see below).

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

2. **Verify the fix against the reproduction** (bugs and regressions only):

   If a reproduction was created in step 5, reuse it to confirm the fix works.

   a. **Recompile swamp** with the fix:
   ```
   deno run compile
   ```
   This produces a `./swamp` binary in the repo root.

   b. **Re-run the reproduction scenario** in the scratch repo using the locally
   compiled binary — **not** the `swamp` on PATH:
   ```
   cd /tmp/swamp-repro-issue-<N>
   /path/to/repo/swamp <same commands from reproduction>
   ```
   Use the absolute path to the compiled binary (e.g.
   `/Users/.../swamp/.claude/worktrees/issue-lifecycle/swamp`).

   c. **Confirm the fix.** The previously failing scenario should now succeed.
   If it still fails, the fix is incomplete — go back to step 1.

   d. **Report verification results** to the human before creating the PR:
   - "Verified: reproduction scenario now passes" or
   - "Verification failed: <what still breaks>"

3. **Create a PR** using the `github-pr` skill
4. **Record the PR number**:
   ```
   swamp model method run issue-<N> implement \
     --input prNumber=<N>
   ```

5. **Wait 3 minutes for CI to start.** Use `sleep 180` — CI takes at least this
   long, so there's no point polling earlier.

6. **Poll for CI results in a loop.** You MUST implement an explicit polling
   loop — do not check once and assume done. The loop works like this:

   ```
   repeat:
     call ci_status
     parse the output — look at EVERY check's status
     if ANY check is "pending", "queued", or "in_progress":
       tell the human: "CI still running — N of M checks complete. Waiting 60s..."
       sleep 60
       go back to repeat
     else:
       all checks are conclusive (passed/failed) — exit the loop
   ```

   The ci_status command:
   ```
   swamp model method run issue-<N> ci_status
   ```

   **Do NOT exit this loop early.** A single ci_status call that shows some
   checks passed does not mean CI is done — other checks may still be running.
   You must confirm that **every** check has a conclusive status (passed or
   failed) before proceeding. The human can always interrupt the loop (e.g.
   "stop", "pause") — respect that immediately. But the agent must never exit
   the loop on its own.

7. **Show the CI results** to the human, grouped by reviewer and severity:
   - Which checks passed/failed
   - Review comments grouped by reviewer
   - Comments sorted by severity (critical first)

8. **If everything is green and approved**, the PR will auto-merge. Call
   `complete` immediately — no need to ask the human:
   ```
   swamp model method run issue-<N> complete
   ```

9. **If there are failures or review comments**, present them and wait for the
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

10. **After pushing fixes, loop back to step 5.** Wait 3 minutes, poll for CI,
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
