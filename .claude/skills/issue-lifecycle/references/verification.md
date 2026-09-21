# Verification Flow

Read this after code conformance review is complete and all deviations are
justified. The `submit-change` workflow runs the same checks as CI, generates
the attestation from its own run record, and publishes it — all **before** a PR
opens.

Read `agent-constraints/verification-conventions.md` for repo-specific workflow
configuration.

## 1. Run Verification

Do **not** call `verify` by hand. The run's first job does it, which is what
lets a re-run refresh the commit the gates compare against — see step 3.

One workflow runs all three verification groups — build, agent reviews, and
skill checks:

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run submit-change \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current) \
  --input issue=<N> \
  --input prTitle="<conventional-commit style title>" \
  --input-file /tmp/pr-body.yaml
```

The run verifies, attests, publishes and opens the PR, so it needs the PR title
and body up front. Put the body in a YAML input file — it is multi-line and
authored by you, unlike the attestation:

```yaml
prBody: |
  ## Summary

  What changed and why.

  ## Test Plan

  How it was verified.
```

Use the `github-pr` skill's conventions for the title and body. Everything else
about the PR — the attestation id, the run id, the pushed commit — comes from
the run.

`SWAMP_WORKFLOWS_DIR=verification` tells swamp to look for workflow files in the
`verification/` directory. Everything runs on the host: the workflow handles
change detection, guards, parallel execution, and result collection. See
`agent-constraints/verification-conventions.md` for details.

Reviews need `~/.config/swamp/verify.env` with `ANTHROPIC_API_KEY`, or a
claude.ai login.

**Re-running after a fix**: if the commit changed, re-run everything — the
deselected groups would have reviewed a different diff, so their evidence is
stale.

Deselect a group only when re-running **the same commit** after a non-code
failure (Claude overloaded, `TESSL_TOKEN` missing, a flaky test):

```
--input runBuild=false --input runSkills=false
```

The attestation carries those groups' results forward from the last run at this
commit where they passed, naming which run each came from. If a group has never
passed at this commit, the gate fails — so deselecting everything is not a
shortcut to green.

## 2. What the Run Does

Everything that used to be an agent step is now a job:

| Job                   | What it does                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-verification`  | Calls `verify`, moving the lifecycle into `verifying` and recording the commit this run verifies                                               |
| `attest`              | Generates the attestation from the run's own record and hashes of the verified commit's config files                                           |
| `record-verification` | Calls `verification_passed` with that attestation — the commit, branch, run id and step list are read out of it                                |
| `publish-attestation` | Posts it to swamp-club via `post_attestation`, which writes an `attestationRecord` receipt                                                     |
| `open-pr`             | Pushes the verified commit, opens **or updates** the PR with the attestation id as an input, and calls `link_pr` with the URL the run produced |

**Do NOT construct, edit or reuse an attestation, and do NOT open the PR by
hand.** There is nothing to fill in: every field comes from the run. An agent
that both performs verification and writes the document attesting to it is a
weaker property than any specific ordering bug, and this is what removes it.

`attest` runs even when verification failed — an attestation recording the
failure is worth having — but `record-verification` and everything after it
depend on the verification groups not having failed, so a failed run publishes
nothing and opens nothing.

See `agent-constraints/verification-conventions.md` for what the attestation
carries and why.

## 3. Handle the Result

### The run succeeded

Read the run record:

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <run-id> --json
```

Present the checklist to the user: every step with its status, model, duration,
and for skipped steps the recorded reason, then the PR the run opened. Include
the run file path so they can inspect the raw data.

Do NOT call `verification_passed` or `link_pr` — `record-verification` and
`open-pr` already did, with data from the run.

**NEVER amend, rebase, or modify the commit after the run.** The attestation is
bound to a commit SHA. Amending — to add a co-author, fix a typo, reword the
message — changes the SHA and CI reports a commit mismatch. If the commit has to
change, re-run `submit-change` on the new SHA.

**Re-run `submit-change` after every push to an open PR.** CI checks that the
attestation's commit equals the PR head, so a new commit needs a new
attestation. The run finds the open PR, comments the new attestation id on it,
and re-links it — it does not open a second PR. This is also how the `pr_failed`
recovery loop works: fix, re-run, and the same PR carries a fresh attestation.

### A verification step failed

`record-verification`, `publish-attestation` and `open-pr` will all show as
skipped. Read the failure:

```
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow submit-change --run <run-id> log --json
```

Present the failures, then record them:

```
swamp model @swamp/issue-lifecycle method run verification_failed issue-<N> \
  --input workflowRunId=<run-id> \
  --input commit=<SHA> \
  --input branch=<branch> \
  --input failureReason="<summary of failures>"
```

This transitions back to `implementing`. Fix the failing code:

- **Build failures** (lint, fmt, test, compile): fix the code directly
- **Review failures**: read the findings, address blocking issues

After fixing, re-run submit-change on the new commit. It calls `verify` again
itself, which refreshes the recorded commit — so the gates compare this run's
records against this run's commit rather than an earlier one.

## 4. The PR Cannot Open Without an Attestation

The workflow is the sanctioned route: the attestation id is an _input_ to the
step that opens the PR, read from the `attestationRecord` that
`post_attestation` writes only when swamp-club accepts the document. An
unattested PR is not rejected — it cannot be expressed.

Someone can still run `gh pr create` by hand, so two checks are the backstop:

1. **`verification-clear`** — a `verificationResult` recording that no step
   failed.
2. **`attestation-posted`** — an `attestationRecord` whose gate passed.

Both also assert the record names the commit `verify` was started for, which
`verify` now persists as `verificationTarget-main`. A result or attestation
belonging to a different commit no longer satisfies either gate. (A record stale
relative to the _working tree_ still can — nothing here reads HEAD.)

Both apply to **`complete`** as well as `link_pr`, since `complete` transitions
the swamp-club issue to `shipped`. `complete` is reachable from `implementing`,
where there may be no code to verify, so the escape stays open — but it has to
be written down:

```
swamp model @swamp/issue-lifecycle method run complete issue-<N> \
  --input reason="docs-only change, nothing to verify"
```

The reason is logged and posted on the issue. It does **not** work on `link_pr`
— that path is absolute.

If you find yourself reaching for `gh pr create`, you are on the unsanctioned
path. Run `submit-change` instead.

The loop is: implement → conformance review → submit-change → fix → re-run →
present what the run produced.
