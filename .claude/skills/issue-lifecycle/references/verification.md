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

## 2. Run the Verification Workflows

Run both verification workflows in parallel inside separate containers. The
container must be built first (`./verification/container/build.sh`).

**Build container** (no API key):

```
docker run --rm \
  -v <repo-root>:<repo-root> \
  -v ~/Library/Caches/deno:/deno-dir \
  -e SWAMP_WORKFLOWS_DIR=verification \
  -w <worktree-path> \
  swamp-club/verify:deno-2.8.3 \
  workflow run verify-build \
  --repo-dir <repo-root> \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

**Review container** (with API key):

```
docker run --rm \
  -v <repo-root>:<repo-root> \
  -v ~/Library/Caches/deno:/deno-dir \
  -e SWAMP_WORKFLOWS_DIR=verification \
  --env-file ~/.config/swamp/verify.env \
  -w <worktree-path> \
  swamp-club/verify:deno-2.8.3 \
  workflow run verify-reviews \
  --repo-dir <repo-root> \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

Launch both commands simultaneously. Replace `<repo-root>` with the main repo
path and `<worktree-path>` with the current working directory. On Linux, use
`~/.cache/deno` instead of `~/Library/Caches/deno`.

The review container needs `~/.config/swamp/verify.env` with the API key. See
`agent-constraints/verification-conventions.md` for setup. Without it, skip the
review container — build verification still works independently.

The `SWAMP_WORKFLOWS_DIR=verification` env var tells swamp to look for workflow
files in the `verification/` directory instead of the default `workflows/`.

The workflow runs lint, fmt check, type check, tests, deps audit, compile, and
agent reviews as a DAG. Build steps run in parallel; reviews run after builds
pass. Each review gets its own isolated subprocess.

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
