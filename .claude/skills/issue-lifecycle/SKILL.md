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
   swamp model method run issue-<N> start --json
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
     --input reasoning="<your analysis>" --json
   ```

5. **Generate an implementation plan**:
   ```
   swamp model method run issue-<N> plan \
     --input summary="..." \
     --input dddAnalysis="..." \
     --input-file steps.json \
     --input testingStrategy="..." \
     --input-file potentialChallenges.json --json
   ```

6. **Show the plan to the human and ask for feedback.** Present it clearly:
   - Summary
   - Each step with files and risks
   - Testing strategy
   - Potential challenges
   - Then ask: "Does this plan look right, or do you have feedback?"

## Plan Iteration Loop

When the human gives feedback (they almost always will on the first plan):

1. **Call iterate** with both the feedback text and your revised plan:
   ```
   swamp model method run issue-<N> iterate \
     --input feedback="<human's feedback>" \
     --input summary="..." \
     --input-file steps.json \
     ... --json
   ```

2. **Show what changed** between the previous and new plan version. Be specific:
   - "Reordered steps 2 and 3 based on your feedback"
   - "Added regression analysis for module X"
   - "Removed step 4 — you're right, that's already handled by..."

3. **Ask for feedback again.** Keep iterating until the human says one of:
   - "approve", "approved", "looks good", "ship it", "go", "LGTM"

4. Only then call `approve`:
   ```
   swamp model method run issue-<N> approve --json
   ```

## Implementation & CI Flow

After plan approval, when the human says to implement:

1. **Do the implementation work** based on the approved plan
2. **Create a PR** using the `github-pr` skill
3. **Record the PR number**:
   ```
   swamp model method run issue-<N> implement \
     --input prNumber=<N> --json
   ```

4. **Wait for CI to complete**, then fetch results:
   ```
   swamp model method run issue-<N> ci_status --json
   ```

5. **Show the CI results** to the human, grouped by reviewer and severity:
   - Which checks passed/failed
   - Review comments grouped by reviewer
   - Comments sorted by severity (critical first)

6. **When the human directs fixes**, parse their instruction:
   - "fix the CRITICAL issues from adversarial review" ->
     `targetReview: "claude-adversarial-review"`, `targetSeverity: "critical"`
   - "address all the review comments" -> no filters
   - "fix the test failures" -> `targetReview: "test"`

   ```
   swamp model method run issue-<N> fix \
     --input directive="<human's instruction>" \
     --input targetReview="<reviewer>" \
     --input targetSeverity="<severity>" --json
   ```

7. **Make the fixes**, push, wait for CI, then call `ci_status` again
8. **Loop until clean** or the human says to complete:
   ```
   swamp model method run issue-<N> complete --json
   ```

## Reviewing Plan History

To review a specific plan version:

```
swamp model method run issue-<N> review --input version=<V> --json
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
