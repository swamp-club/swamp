# Implementation & CI Flow

Read this after the plan is approved and the human says to implement. The
`approve` method already transitioned the issue to "in progress" in swamp-club.

## 1. Signal Implementation Started

Before writing any code, signal that implementation has begun:

```
swamp model method run issue-<N> implement
```

This transitions the phase to `implementing`, posts a GitHub comment, and
notifies swamp-club that work is underway. Do this **before** touching any code.

## 2. Do the Implementation Work

Follow the approved plan step by step.

## 3. Verify the Fix Against the Reproduction

**Bugs and regressions only — skip for features.**

If a reproduction was created during triage, reuse it to confirm the fix works.

Read `agent-constraints/implementation-conventions.md` at the repo root for
repo-specific verification steps (build commands, binary paths, test commands).
If it does not exist, use the project's standard build/test process from
CLAUDE.md.

Report verification results to the human before creating the PR:

- "Verified: reproduction scenario now passes" or
- "Verification failed: <what still breaks>"

## 4. Create a PR

Read `agent-constraints/implementation-conventions.md` for PR creation guidance.
If it does not exist, create a PR using `gh pr create`.

## 5. Record the PR Number

After the PR is created, link it to the issue so `ci_status` can find it:

```
swamp model method run issue-<N> record_pr \
  --input prNumber=<N>
```

## 6. Wait for CI to Start

Use `sleep 180` — CI takes at least 3 minutes, so there's no point polling
earlier.

## 7. Poll for CI Results

You MUST implement an explicit polling loop — do not check once and assume done:

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

**Do NOT exit this loop early.** A single ci_status call that shows some checks
passed does not mean CI is done — other checks may still be running. You must
confirm that **every** check has a conclusive status (passed or failed) before
proceeding. The human can always interrupt the loop (e.g. "stop", "pause") —
respect that immediately. But the agent must never exit the loop on its own.

## 8. Show CI Results

Show results to the human, grouped by reviewer and severity:

- Which checks passed/failed
- Review comments grouped by reviewer
- Comments sorted by severity (critical first)

## 9. If Everything is Green and Approved

The PR will auto-merge. Call `complete` immediately — no need to ask the human:

```
swamp model method run issue-<N> complete
```

## 10. If There Are Failures or Review Comments

Present them and wait for the human's direction. Parse their instruction:

- "fix the CRITICAL issues from adversarial review" →
  `targetReview: "claude-adversarial-review"`, `targetSeverity: "critical"`
- "address all the review comments" → no filters
- "fix the test failures" → `targetReview: "test"`

```
swamp model method run issue-<N> fix \
  --input directive="<human's instruction>" \
  --input targetReview="<reviewer>" \
  --input targetSeverity="<severity>"
```

## 11. After Pushing Fixes

Loop back to step 6. Wait 3 minutes, poll for CI, show results. Repeat until
clean or the human says to stop.

**IMPORTANT:** Do not break out of this loop voluntarily. The human should never
have to manually check CI or come back to ask "what happened?" — the skill stays
in the conversation and drives through to completion. If the human wants to
break out (e.g. "I'll come back to this later", "pause", "stop"), respect that
immediately — but it must be their decision, never yours.
