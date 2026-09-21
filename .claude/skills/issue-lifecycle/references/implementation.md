# Implementation Flow

Read this after the plan is approved and the human says to implement. The
`approve` method already transitioned the swamp-club issue to `in_progress`.

## 1. Signal Implementation Started

Before writing any code, signal that implementation has begun:

```
swamp model @swamp/issue-lifecycle method run implement issue-<N>
```

This transitions the phase to `implementing` and posts an
`implementation_started` lifecycle entry on the swamp-club issue. Do this
**before** touching any code.

## 2. Do the Implementation Work

Follow the approved plan step by step.

## 3. Verify the Fix Against the Reproduction

**Bugs and regressions only — skip for features and security issues.**

If a reproduction was created during triage, reuse it to confirm the fix works.

Read `agent-constraints/implementation-conventions.md` at the repo root for
repo-specific verification steps (build commands, binary paths, test commands).
If it does not exist, use the project's standard build/test process from
CLAUDE.md.

Report verification results to the human before creating the PR:

- "Verified: reproduction scenario now passes" or
- "Verification failed: <what still breaks>"

## 3a. Code Conformance Review

**Before verification**, read
[code-conformance-review.md](code-conformance-review.md) and run the code
conformance review. This adversarially compares the implemented code against the
approved plan. All deviations must be justified before proceeding.

## 3b. Verification Loop

**After code conformance review**, read [verification.md](verification.md) and
run the `submit-change` workflow. It runs lint, test, compile, agent reviews and
skill checks — the same checks as CI — then attests, publishes and opens the PR
in the same run. Iterate until every step passes; nothing downstream of
verification runs until it does.

## 4. The PR Is Opened by the Run

Do NOT run `gh pr create`. The `submit-change` workflow verifies, attests,
publishes and opens the PR in one run — see [verification.md](verification.md).
The attestation id is an _input_ to the step that opens the PR, so a PR with no
attestation behind it cannot be expressed rather than being caught afterwards.

**Ask the human before running `submit-change`.** The human gate sits before the
run, not inside it: the real decision is "ship this commit", and it is better
made up front with more information than half-way through a sequence that would
then sit parked. Present a summary of the changes and only run after explicit
confirmation.

**DO NOT amend, rebase, or modify the verified commit after the run.** The
attestation is bound to the commit SHA — amending (even just to add a co-author
line) changes the SHA and invalidates it. The co-author trailer must be in the
ORIGINAL commit, not added via amend afterwards. If the commit has already been
amended, re-run `submit-change` on the new SHA.

Read `agent-constraints/implementation-conventions.md` for repo-specific PR
conventions, and the `github-pr` skill for the title and body to pass in.

## 4a. The PR Link

`open-pr`'s `link-pr` step calls `link_pr` with the URL the run produced, which
writes a `pullRequest-main` resource, transitions the phase to `pr_open`, and
posts a `pr_linked` lifecycle entry on the swamp-club issue. The swamp-club
status stays at `in_progress` — there is no new status for `pr_open`; the PR
link is additional evidence attached to the in-progress state.

Calling `link_pr` by hand is the manual path, and it is gated:
`verification-clear` requires a passing `verificationResult` and
`attestation-posted` requires an `attestationRecord` whose gate passed.

```
swamp model @swamp/issue-lifecycle method run link_pr issue-<N> --input url=<PR URL>
```

`link_pr` is **idempotent** — call it again with a new URL if:

- CI fails and you force-push a different PR
- The first PR is closed and a replacement is opened
- You recorded the wrong URL the first time

Each call overwrites `pullRequest-main` with the latest URL and refreshes
`linkedAt`. A new `pr_linked` entry is posted on every call.

Calling `link_pr` is **encouraged but not enforced** — `complete` still accepts
`implementing` as a valid source phase for backwards compatibility with legacy
records. Prefer the `implementing → link_pr → complete` flow for all new work so
the lifecycle record carries the PR link.

## 4b. Wait for CI and Check PR Status

After linking the PR, wait at least 3 minutes for CI to run. The model enforces
a `pr-cooldown` check — calling `pr_merged` or `pr_failed` within 3 minutes of
`link_pr` will be rejected.

Check the PR status externally (e.g.,
`gh pr view <url> --json state,statusCheckRollup`):

- **PR merged**: call `pr_merged` to transition to `releasing`
  ```
  swamp model @swamp/issue-lifecycle method run pr_merged issue-<N>
  ```
- **PR failed** (CI red, changes requested): call `pr_failed` with the reason
  ```
  swamp model @swamp/issue-lifecycle method run pr_failed issue-<N> --input reason="CI failed: type check errors"
  ```
- **PR still open and passing**: wait and check again later.

## 4c. Handle PR Failure

When in `pr_failed`, diagnose and fix the issue, then re-run `submit-change` on
the new commit. CI checks that the attestation's commit equals the PR head, so a
fix needs a fresh attestation — the run finds the open PR, comments the new
attestation id on it, and re-links it rather than opening a second one. Do not
push by hand and call `link_pr` yourself; the run does both, and a push without
a re-verification leaves the PR carrying an attestation for a commit that is no
longer its head.

The run calls `verify` itself, and `verify` is legal from `pr_failed` and
`pr_open`, so no phase juggling is needed to re-verify a change whose commit
moved.

For major rework, call `implement` to return to the implementing phase:

```
swamp model @swamp/issue-lifecycle method run implement issue-<N>
```

## 5. Ship the Release

After `pr_merged` transitions to `releasing`, wait for the release build to
complete. Once the release is out, call `ship`:

```
swamp model @swamp/issue-lifecycle method run ship issue-<N>
```

Optionally pass release metadata:

```
swamp model @swamp/issue-lifecycle method run ship issue-<N> --input releaseUrl=<URL> --input releaseNotes="Bug fix release"
```

This transitions the phase to `notify`, transitions the swamp-club status to
`shipped`, and posts a `shipped` lifecycle entry.

For quick close-out (e.g., the PR merged and you just want to wrap up),
`complete` still works from `implementing`, `pr_open`, or `releasing`
(transitions to `notify`).

`complete` transitions the swamp-club issue to `shipped`, so it carries the same
gates as `link_pr`: `verification-clear` and `attestation-posted`. From
`pr_open` or `releasing` those already hold. From `implementing` there may be no
code to verify, so the escape stays open — but it has to be stated:

```
swamp model @swamp/issue-lifecycle method run complete issue-<N> \
  --input reason="docs-only change, nothing to verify"
```

The reason is logged and recorded on the issue. Do not reach for it to skip a
verification run that should have happened.

## 6. Notify the Contributor

After `ship` or `complete`, the phase is `notify`. Check whether the issue
author is an external contributor:

```
gh api /repos/swamp-club/swamp/collaborators --jq '.[].login' | grep -qx '<author>'
```

- **External** (not a collaborator): call `notify` to post a thank-you ripple:
  ```
  swamp model @swamp/issue-lifecycle method run notify issue-<N>
  ```
- **Collaborator**: call `skip_notify` to proceed:
  ```
  swamp model @swamp/issue-lifecycle method run skip_notify issue-<N>
  ```

## 7. Session Summary

After `notify` or `skip_notify`, the phase is `summarizing`. Restate the
original problem and the delivered outcome in simple, plain-language terms. The
human should be able to read these two statements and immediately judge whether
the work was on target.

```
swamp model @swamp/issue-lifecycle method run summarize issue-<N> \
  --input originalProblem="<plain-language restatement of the bug or feature request>" \
  --input deliveredOutcome="<plain-language description of what was built or fixed>" \
  --input outcomeMet=<true|false>
```

This transitions the phase to `done` and posts a `session_summarized` lifecycle
entry.
