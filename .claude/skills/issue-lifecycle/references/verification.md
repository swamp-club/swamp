# Verification Flow

Read this after code conformance review is complete and all deviations are
justified. The `submit-change` workflow runs the same checks as CI, generates
the attestation from its own run record, and publishes it — all **before** a PR
opens.

Read `agent-constraints/verification-conventions.md` for repo-specific workflow
configuration.

## 1. Start Verification

Transition the lifecycle to the `verifying` phase:

```
swamp model @swamp/issue-lifecycle method run verify issue-<N> \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

## 2. Run Verification

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

**Re-running after a fix**: re-run the whole workflow unless you can say why a
group cannot be affected. When you can, deselect it with a boolean input —
`--input runSkills=false`. The skipped steps record `!inputs.runSkills` as their
reason, so the attestation says the group was deselected rather than quietly
counting more skips.

## 3. What the Run Does After Verification

Everything that used to be an agent step is now a job:

| Job                   | What it does                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `attest`              | Generates the attestation from the run's own record and hashes of the verified commit's config files                            |
| `record-verification` | Calls `verification_passed` with that attestation — the commit, branch, run id and step list are read out of it                 |
| `publish-attestation` | Posts it to swamp-club via `post_attestation`, which writes an `attestationRecord` receipt                                      |
| `open-pr`             | Pushes the verified commit, opens the PR with the attestation id as an input, and calls `link_pr` with the URL the run produced |

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

## 4. Handle the Result

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

After fixing, return to step 1 and re-run. Repeat until the run goes green.

## 5. The PR Cannot Open Without an Attestation

The workflow is the sanctioned route: the attestation id is an _input_ to the
step that opens the PR, read from the `attestationRecord` that
`post_attestation` writes only when swamp-club accepts the document. An
unattested PR is not rejected — it cannot be expressed.

Someone can still run `gh pr create` by hand, so `link_pr` keeps two checks as
the backstop:

1. **`verification-clear`** — a `verificationResult` recording that no step
   failed.
2. **`attestation-posted`** — an `attestationRecord` whose gate passed.

If you find yourself reaching for `gh pr create`, you are on the unsanctioned
path. Run `submit-change` instead.

The loop is: implement → conformance review → submit-change → fix → re-run →
present what the run produced.
