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
  --input issue=<N>
```

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

## 3. The Attestation Is Built and Published by the Run

The workflow's `attest` step generates the attestation from the run's own record
— step statuses, durations, skip reasons — and hashes of the config files at the
verified commit. The `publish-attestation` job posts it to swamp-club through
the issue's lifecycle instance, which writes an `attestationRecord` receipt
locally.

**Do NOT construct, edit or reuse an attestation.** There is nothing to fill in:
every field comes from the run. An agent that both performs verification and
writes the document attesting to it is a weaker property than any specific
ordering bug, and this is what removes it.

See `agent-constraints/verification-conventions.md` for what the attestation
carries and why.

## 4. Handle the Result

### All steps passed

**Only proceed when no step failed** — a partial pass is NOT a pass. If any step
failed, go to "Any step failed" below.

1. Read the run record:

   ```
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <run-id> --json
   ```

2. Call `verification_passed` with what the run recorded:

   ```
   swamp model @swamp/issue-lifecycle method run verification_passed issue-<N> \
     --input workflowRunId=<run-id> \
     --input commit=<SHA> \
     --input branch=<branch> \
     --input steps='[{"job":"build-static-analysis","step":"lint","model":"build-lint","status":"succeeded"}, ...]'
   ```

   Populate `steps` from the run record. Include every step with its actual
   status (succeeded, failed, or skipped).

3. **Present the verification checklist to the user.** Show every step with its
   status, model, duration, and for skipped steps the recorded reason. Include
   the run file path so the user can inspect the raw data.

4. Proceed to open a PR — read the "Create a PR" section in
   [implementation.md](implementation.md).

   **NEVER amend, rebase, or modify the commit after the attestation is
   published.** The attestation is bound to a commit SHA. Amending — to add a
   co-author, fix a typo, reword the message — changes the SHA and CI reports a
   commit mismatch. If the commit has to change, re-run `submit-change` on the
   new SHA.

### Any step failed

Call `verification_failed` with the failure details:

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

After fixing, return to step 1 and re-verify. Repeat until all steps pass.

## 5. The PR Cannot Open Without an Attestation

`link_pr` has two gates it cannot get past:

1. **`verification-clear`** — a `verificationResult` recording that no step
   failed.
2. **`attestation-posted`** — an `attestationRecord`, written only when
   swamp-club accepts an attestation, whose gate passed.

The second is a backstop, not the mechanism: someone can still run
`gh pr create` by hand, so the check is the belt. The sanctioned route is the
`submit-change` workflow, where the attestation is a data dependency of PR
creation rather than a claim checked afterwards.

The loop is: implement → conformance review → submit-change → fix → re-run →
present the checklist → PR.
