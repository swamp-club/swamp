# Verification Conventions

## Build Verification (Host Workflow)

Build checks run as a swamp workflow on the host — native filesystem speed,
same Deno that's already installed. Isolation comes from running in a fresh
checkout.

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-build \
  --input commit=<SHA> \
  --input branch=<branch>
```

All steps use `command/shell` which correctly fails on non-zero exit code —
lint, test, and compile failures are reported accurately.

## Agent Reviews (Host Workflow)

Reviews run as a swamp workflow on the host (not in a container) so the claude
CLI has full project context — CLAUDE.md, skills, and the codebase.

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-reviews \
  --input commit=<SHA> \
  --input branch=<branch>
```

The workflow:

1. Detects changed files via `@swamp/git` diff
2. Runs applicable reviews in parallel using `command/shell` steps that invoke
   `claude -p` with the review prompt + diff
3. Each review uses the factory pattern — one `reviewer` model, called once per
   review type with different prompt files and models

### Guards

Reviews are guarded by file path — they skip when no relevant files changed:

| Review | Guard (run when any match) | Model |
| --- | --- | --- |
| code-review | always | claude-opus-4-6 |
| adversarial-review | `src/domain/`, `src/infrastructure/`, `src/libswamp/`, `src/serve/`, `src/worker/` | claude-opus-4-6 |
| ux-review | `src/cli/`, `src/presentation/`, `src/domain/errors.ts`, `src/libswamp/` | claude-sonnet-4-6 |
| ci-security-review | `.github/workflows/` | claude-opus-4-6 |

### Authentication

The claude CLI authenticates via one of two methods:

1. **`~/.config/swamp/verify.env`** — if this file exists with
   `ANTHROPIC_API_KEY=sk-ant-...`, export it before running the workflow.
2. **claude.ai login** — if no env file exists, the CLI uses your existing
   claude.ai login. No additional setup needed.

To create the env file (optional):

```
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/.config/swamp/verify.env
chmod 600 ~/.config/swamp/verify.env
```

## Running Both in Parallel

The agent launches the build and review workflows simultaneously. Both must
pass for verification to succeed.

After each workflow completes, present the commands to the user so they can
inspect the attestations:

```
# Build attestation (human-readable)
SWAMP_WORKFLOWS_DIR=verification swamp workflow history verify-build

# Build attestation (JSON for programmatic use)
SWAMP_WORKFLOWS_DIR=verification swamp workflow history verify-build --json

# Review attestation — shows which reviews ran, passed, failed, or skipped
SWAMP_WORKFLOWS_DIR=verification swamp workflow history verify-reviews
SWAMP_WORKFLOWS_DIR=verification swamp workflow history verify-reviews --json

# Review findings — each review type has its own model name
swamp data get review-code log              # code review
swamp data get review-adversarial log       # adversarial review
swamp data get review-ux log                # UX review
swamp data get review-ci-security log       # CI security review
```

## Verification Checklist

After both workflows complete, the agent constructs a **combined verification
checklist** from the two workflow run outputs and presents it to the user. This
is the single view of everything that ran.

```
Verification Checklist (commit <short-sha>)
─────────────────────────────────────────────────────────────
✓ Static Analysis
  ✓ lint             build-lint         2.1s
  ✓ fmt-check        build-fmt          0.8s
  ✓ type-check       build-check        4.2s

✓ Tests
  ✓ run-tests        build-tests       12.3s

✓ Deps Audit
  ✓ vuln-scan        build-audit        1.5s

✓ Compile + Smoke
  ✓ compile          build-compile      8.7s
  ✓ binary-check     build-smoke        0.1s

✓ Code Review
  ✓ review           review-code       87.0s   VERDICT: pass

○ Adversarial Review
  ○ review           review-adversarial  —     skipped (no core changes)

○ UX Review
  ○ review           review-ux           —     skipped (no UX changes)

○ CI Security Review
  ○ review           review-ci-security  —     skipped (no workflow changes)

Gate: 8/8 passed, 3 skipped (guard)
Total: 1m 45s
```

To construct this checklist:

1. Read the build workflow run:
   ```
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history verify-build --json
   ```

2. Read the review workflow run:
   ```
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history verify-reviews --json
   ```

3. For each step, extract: job name, step name, model name, duration, and
   status (succeeded/failed/skipped). For review steps that ran, include the
   VERDICT from the review log.

4. Construct the combined attestation JSON:

   ```json
   {
     "version": "1",
     "type": "verification-attestation",
     "subject": {
       "commit": "<full SHA>",
       "branch": "<branch name>"
     },
     "environment": {
       "denoVersion": "2.8.3",
       "os": "<platform>",
       "swampVersion": "<version>"
     },
     "configIntegrity": {
       "claudeMd": "<sha256 of CLAUDE.md>",
       "prompts": {
         "code-review": "<sha256 of verification/review-prompts/code-review.md>",
         "adversarial-review": "<sha256 of verification/review-prompts/adversarial-review.md>",
         "ux-review": "<sha256 of verification/review-prompts/ux-review.md>",
         "ci-security-review": "<sha256 of verification/review-prompts/ci-security-review.md>"
       },
       "workflows": {
         "verify-build": "<sha256 of verification/workflow-verify-build.yaml>",
         "verify-reviews": "<sha256 of verification/workflow-verify-reviews.yaml>"
       }
     },
     "reviewConfig": {
       "code-review": { "model": "claude-opus-4-6", "ran": true },
       "adversarial-review": { "model": "claude-opus-4-6", "ran": false, "reason": "guard" },
       "ux-review": { "model": "claude-sonnet-4-6", "ran": false, "reason": "guard" },
       "ci-security-review": { "model": "claude-opus-4-6", "ran": false, "reason": "guard" }
     },
     "steps": [
       {
         "job": "static-analysis",
         "step": "lint",
         "model": "build-lint",
         "status": "succeeded",
         "durationMs": 2100
       },
       {
         "job": "reviews",
         "step": "code-review",
         "model": "review-code",
         "status": "succeeded",
         "durationMs": 87000,
         "verdict": "pass",
         "findings": 0
       },
       {
         "job": "reviews",
         "step": "ux-review",
         "model": "review-ux",
         "status": "skipped",
         "reason": "guard: no UX changes"
       }
     ],
     "gate": {
       "allPassed": true,
       "stepsCompleted": 8,
       "stepsTotal": 11,
       "stepsSkipped": 3
     },
     "timing": {
       "startedAt": "<ISO 8601>",
       "completedAt": "<ISO 8601>",
       "totalDurationMs": 105000
     },
     "runs": {
       "build": "<workflow-run-id>",
       "reviews": "<workflow-run-id>"
     }
   }
   ```

   The `configIntegrity` section proves the review prompts, workflows, and
   CLAUDE.md used match the versions at the verified commit. Anyone can
   checkout that commit, hash the files, and verify they match. Compute
   hashes with:

   ```bash
   sha256sum CLAUDE.md verification/review-prompts/*.md verification/workflow-verify-*.yaml
   ```

5. Present the checklist AND the workflow run file paths to the user so they
   can inspect the full details:

   ```
   Build run:  .swamp/workflow-runs/<id>/workflow-run-<build-run-id>.yaml
   Review run: .swamp/workflow-runs/<id>/workflow-run-<review-run-id>.yaml
   ```

6. Determine the overall result. **Only call `verification_passed` when
   `gate.allPassed` is true — every non-skipped step must have succeeded.**
   If any step failed, call `verification_failed` instead. Do not treat a
   partial pass as success.

   - **All pass** → post the attestation JSON to swamp-club as part of the
     `verification_passed` call so the team has a permanent, shared record
   - **Any fail** → call `verification_failed`, fix the issues, re-verify

## Handling Failures

When verification fails, present the failed checklist to the user with a clear
summary of what failed and what the agent will do to fix it.

### 1. Present failures to the user

Show the verification checklist with the failures highlighted, then tell the
user what went wrong and what you're going to do:

- **Test failures**: "N tests failed. I'll read the error output, fix the
  failing tests, and re-run verification."
- **Lint/fmt/type errors**: "Build checks failed (lint/fmt/type). I'll fix
  the issues and re-run."
- **Review blocking findings**: "The code review found N blocking issues.
  I'll address each finding and re-run verification."
- **Compile errors**: "Compilation failed. I'll fix the build error and
  re-run."

### 2. Read the failure details

For failed build steps:
```bash
swamp data list <model-name>
swamp data get <model-name> <data-name> --json
```
The `stderr` field has the full error output. The `exitCode` confirms the
failure.

For failed reviews:
```bash
swamp data get review-code log              # code review
swamp data get review-adversarial log       # adversarial review
swamp data get review-ux log                # UX review
swamp data get review-ci-security log       # CI security review
```

### 3. Fix the issues

- **Lint errors**: run `deno lint` locally, fix the flagged issues
- **Format errors**: run `deno fmt` to auto-fix
- **Type errors**: run `deno check` locally, fix the type issues
- **Test failures**: read the test names and errors from stderr, fix the
  failing tests, run `deno run test <file>` to verify the fix locally
- **Compile errors**: fix the build issue, run `deno task compile` locally
- **Review blocking findings**: read each finding, fix the code issue,
  explain to the user what was changed and why

### 4. Re-run verification

Commit the fixes, then re-run BOTH verification workflows:

```bash
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-build \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)

SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-reviews \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

### 5. Repeat until green

Repeat steps 1–4 until all build steps pass and all reviews return
`VERDICT: pass`. Present the full verification checklist to the user after
each run.

Do NOT open a PR until the user has seen a fully green checklist and
confirmed they want to proceed.

## Review Prompts

Agent review prompts live at `verification/review-prompts/`. Each prompt is
read by the workflow step and combined with the diff. The prompts are the single
source of truth for review criteria — both the verification workflow and CI
reference them.
