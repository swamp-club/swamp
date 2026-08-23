# Verification Flow

Read this after code conformance review is complete and all deviations are
justified. The verification loop runs the same checks as CI in a container
sandbox **before** opening a PR.

Read `agent-constraints/verification-conventions.md` for repo-specific container
and workflow configuration.

## 1. Start Verification

Transition the lifecycle to the `verifying` phase:

```
swamp model @swamp/issue-lifecycle method run verify issue-<N> \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

## 2. Run Verification

Launch build verification and agent reviews in parallel. The container must be
built first (`./verification/container/build.sh`).

**Build** (host workflow):

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-build \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

**Reviews** (host workflow):

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-reviews \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

Reviews run on the host (not in a container) as a swamp workflow that invokes
`claude -p` for each review type. The workflow handles change detection, guards,
parallel execution, and result collection. See
`agent-constraints/verification-conventions.md` for details.

Both workflows run on the host. `SWAMP_WORKFLOWS_DIR=verification` tells swamp
to look for workflow files in the `verification/` directory.

Reviews need `~/.config/swamp/verify.env` with `ANTHROPIC_API_KEY`, or a
claude.ai login. Without either, skip reviews — build verification still works
independently.

## 3. Read the Attestation

The workflow produces a verification attestation on completion (pass or fail).
Look for the attestation in the workflow output — it shows a checklist of every
step with pass/fail status.

If any step failed, the attestation includes retrieval commands to get the full
output:

```
swamp data get <model-name> <data-name>
```

## 4. Handle the Result

### All steps passed

Call `verification_passed` with the checklist data from the attestation:

```
swamp model @swamp/issue-lifecycle method run verification_passed issue-<N> \
  --input workflowRunId=<run-id> \
  --input commit=<SHA> \
  --input branch=<branch> \
  --input steps='[{"job":"static-analysis","step":"lint","model":"@swamp/deno-runner","method":"task","status":"succeeded"}, ...]'
```

Populate the `steps` array from the attestation output. Include every step with
its actual status (succeeded, failed, or skipped).

Then proceed to open a PR — read the "Create a PR" section in
[implementation.md](implementation.md).

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

## 5. Do NOT Open a PR Without Verification

The `link_pr` method requires a passing verification result. If you skip
verification and try to link a PR directly, it will be missing the
`verificationResult` data that the lifecycle checks for.

The loop is: implement → conformance review → verify → fix → re-verify → PR.
