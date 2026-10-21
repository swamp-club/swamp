# Implementation Flow

Read this after the plan is approved and the human says to implement. The
`approve` method already transitioned the swamp-club issue to `in_progress`.

## 1. Signal Implementation Started

Before writing any code, signal that implementation has begun:

```
swamp behavior run @swamp/issue-lifecycle implement issue-<N>
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
run the verification workflows on the host. These run lint, test, compile, and
agent reviews — the same checks as CI — before a PR is opened. The agent
iterates until all steps pass.

Do NOT proceed to create a PR until verification passes.

## 4. Create a PR

**PREREQUISITE: The verification attestation MUST be posted to swamp-club before
opening a PR.** If you have not yet posted the attestation via
`POST /api/v1/admin/attestations`, STOP — go back to
[verification.md](verification.md) step 4 and complete the attestation flow
first. Do NOT skip this step. Do NOT open a PR without a posted attestation.

**DO NOT amend, rebase, or modify the verified commit after the attestation has
been posted.** The attestation is bound to the commit SHA — amending (even just
to add a co-author line) changes the SHA and invalidates the attestation. The
co-author trailer must be included in the ORIGINAL commit, not added via amend
afterwards. If the commit has already been amended, you must re-run verification
and post a new attestation for the new SHA.

**Always ask the human before opening a PR.** Do not create the PR automatically
— present a summary of the changes and ask if they are ready to open it. Only
proceed after explicit confirmation.

Use the repository's normal PR tooling. Read
`agent-constraints/implementation-conventions.md` for repo-specific PR
conventions.

## 4a. Link the PR

After the PR is open, record its URL on the lifecycle so the swamp-club record
points to where the fix lives:

```
swamp behavior run @swamp/issue-lifecycle link_pr issue-<N> --input url=<PR URL>
```

This writes a `pullRequest-main` resource, transitions the phase to `pr_open`,
records the PR on the swamp-club issue (and on every linked issue), and posts a
`pr_linked` lifecycle entry. The swamp-club status stays at `in_progress` —
there is no new status for `pr_open`; the PR link is additional evidence
attached to the in-progress state.

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
  swamp behavior run @swamp/issue-lifecycle pr_merged issue-<N>
  ```
- **PR failed** (CI red, changes requested): call `pr_failed` with the reason
  ```
  swamp behavior run @swamp/issue-lifecycle pr_failed issue-<N> --input reason="CI failed: type check errors"
  ```
- **PR still open and passing**: wait and check again later.

## 4c. Handle PR Failure

When in `pr_failed`, diagnose and fix the issue. Then either:

- Push fixes and call `link_pr` again (same or new PR URL) to return to
  `pr_open`:
  ```
  swamp behavior run @swamp/issue-lifecycle link_pr issue-<N> --input url=<PR URL>
  ```
- Call `implement` to go back to the implementing phase for major rework:
  ```
  swamp behavior run @swamp/issue-lifecycle implement issue-<N>
  ```

## 5. Ship the Release

For the swamp CLI, after `pr_merged` transitions to `releasing`, check
`@swamp/ci-artifact/release` on `https://ops.swamp-club.com`. A webhook starts
the release there. GitHub Actions completion or webhook delivery alone is not
shipping evidence.

**Ship as soon as an ops release run has started and its `build` job has
`status: succeeded`, with a built revision containing the merged change.** Do
not wait for the whole run, UAT, Windows smoke, or publish to finish. Starting a
run alone is insufficient. A subsequent successful build qualifies if it
contains the change, even if the original build failed.

### Authenticate and inspect ops

Use the installed CLI and verify command schemas with `swamp help` before
running these commands. The user needs authenticated read access to the ops
server; swamp-club login or a dashboard browser session alone does not establish
CLI server credentials. If credentials are missing or expired, have the user
complete the server login flow:

```
swamp auth server-login --server https://ops.swamp-club.com
```

If access is denied, ask the user to obtain read access. Leave the issue in
`releasing` while authentication, access, or build evidence is unavailable; do
not use `complete` to bypass this check.

Find release runs and inspect candidates by their specific run IDs:

```
swamp workflow history search --workflow @swamp/ci-artifact/release --server https://ops.swamp-club.com --json
swamp workflow history get <run-id> --server https://ops.swamp-club.com --json
```

Check the returned `workflowName`, `startedAt`, and the job named `build` in
`jobs`. Require that job and its step named `build` to have `status: succeeded`.
Read `outputs.repository` and `outputs.revision` from that step (or its build
data artifact's `attributes`); require repository `swamp-club/swamp`. Compare
the full built revision with the PR's merge commit, obtained with
`gh pr view <PR-URL> --json mergeCommit`. For a different revision, fetch the
commits and require
`git merge-base --is-ancestor <merge-commit> <built-revision>` to succeed. A
newer timestamp or version alone does not prove inclusion.

If the build is pending, running, failed, cancelled, or missing, keep checking
this run or subsequent release runs. Never filter only for whole-run success: a
running release can already have a qualifying successful build. If revision
evidence is missing or ancestry cannot be verified, stay in `releasing`.

### Record shipping evidence

Use the qualifying run's dashboard URL as `releaseUrl` and include its version,
built revision, and successful build in `releaseNotes`:

```
swamp behavior run @swamp/issue-lifecycle ship issue-<N> \
  --input releaseUrl="https://ops.swamp-club.com/dashboard/workflows/@swamp%2Fci-artifact%2Frelease/runs/<run-id>" \
  --input releaseNotes="Ops build succeeded for <version> at <built-revision>, containing merge <merge-commit>."
```

Record the subsequent run's URL if it supplied the successful build. This
transitions the phase to `notify`, transitions the swamp-club status to
`shipped`, and posts a `shipped` lifecycle entry. Continue through notification
and summary immediately.

For other repositories, follow their release conventions and pass appropriate
release metadata to `ship`. `complete` remains available for work that has no
release build, from `implementing`, `pr_open`, or `releasing` (to `notify`).

## 6. Notify the Contributor

After `ship` or `complete`, the phase is `notify`. Run `notify` and let the
model decide — it checks the author's swamp-club user id against the swamp-club
team roster (eligible assignees):

```
swamp behavior run @swamp/issue-lifecycle notify issue-<N>
```

- A team member is skipped; anyone else gets a thank-you ripple.
- If the issue or roster lookup fails, `notify` posts nothing and the phase
  stays `notify`. Ask the human, then re-run it, add `--input force=true` to
  thank the author anyway, or run `skip_notify`.

## 7. Session Summary

After `notify` or `skip_notify`, the phase is `summarizing`. Restate the
original problem and the delivered outcome in simple, plain-language terms. The
human should be able to read these two statements and immediately judge whether
the work was on target.

```
swamp behavior run @swamp/issue-lifecycle summarize issue-<N> \
  --input originalProblem="<plain-language restatement of the bug or feature request>" \
  --input deliveredOutcome="<plain-language description of what was built or fixed>" \
  --input outcomeMet=<true|false>
```

This transitions the phase to `done` and posts a `session_summarized` lifecycle
entry. When the lifecycle carries linked issues, also pass `linkedOutcomes` with
one outcome per linked issue — see [linked-issues.md](linked-issues.md).
