# Verification Conventions

## Build Verification (Host Workflow)

Build checks run as a swamp workflow on the host — native filesystem speed,
same Deno that's already installed. Isolation comes from a fresh `git worktree`
at the verified commit in `/tmp/swamp-verify-build-<run-id>`. Each workflow run
gets its own unique directory (keyed by run ID, not commit SHA) so multiple
verifications can run in parallel without colliding.

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-build \
  --input commit=<SHA> \
  --input branch=<branch>
```

The workflow creates the worktree in a `setup` job, runs all build steps with
`workingDir` pointing at it, and removes the worktree in a `cleanup` job that
fires regardless of pass/fail.

All steps use `command/shell` which correctly fails on non-zero exit code —
lint, test, and compile failures are reported accurately.

## Agent Reviews (Host Workflow)

Reviews run as a swamp workflow on the host (not in a container) so the claude
CLI has full project context — CLAUDE.md, skills, and the codebase. Like the
build workflow, reviews run in a fresh `git worktree` at the verified commit
(`/tmp/swamp-verify-reviews-<run-id>`) so that `claude -p`'s Read/Glob/Grep
tools see the committed file state, not the caller's working tree.

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-reviews \
  --input commit=<SHA> \
  --input branch=<branch>
```

The workflow:

1. Creates a clean worktree at the verified commit
2. Detects changed files via `@swamp/git` diff (full diff, then `nameOnly` for
   the file list used by guards)
3. Runs applicable reviews in parallel using `command/shell` steps that invoke
   `claude -p` with the review prompt + diff, with `workingDir` set to the
   worktree
4. Each review uses the factory pattern — one `reviewer` model, called once per
   review type with different prompt files and models
5. Review diffs use `git merge-base origin/main HEAD` so only the branch's own
   changes are reviewed — the setup step fetches `origin main` first to ensure
   the diff base is current regardless of local branch state
6. Cleans up the worktree regardless of pass/fail

### Guards

Reviews are guarded by file path — they skip when no relevant files changed:

| Review | Guard (run when any match) | Model |
| --- | --- | --- |
| code-review | always | claude-opus-4-6 |
| adversarial-review | `src/domain/`, `src/infrastructure/`, `src/libswamp/`, `src/serve/`, `src/worker/` | claude-opus-4-6 |
| ux-review | `src/cli/commands/`, `src/presentation/`, `src/domain/errors.ts`, `src/libswamp/` | claude-sonnet-4-6 |
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
inspect the attestations. Use `--input commit=<SHA>` to find the correct run
when multiple verifications run in parallel:

```
# 1. Find the run IDs for this commit
SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
  --workflow verify-build --input commit=<SHA> --json
SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
  --workflow verify-reviews --input commit=<SHA> --json

# 2. Get detailed step data (duration, status, data artifacts)
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <build-run-id> --json
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <reviews-run-id> --json

# 3. Read step output (e.g. review findings or build errors)
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow verify-reviews --run <reviews-run-id> log --json
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

1. Find the run IDs for this commit:
   ```
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
     --workflow verify-build --input commit=<SHA> --json
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
     --workflow verify-reviews --input commit=<SHA> --json
   ```
   The `--input commit=<SHA>` filter ensures you get the correct run when
   multiple verifications run in parallel across worktrees.

2. Get detailed step data for each run:
   ```
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <build-run-id> --json
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <reviews-run-id> --json
   ```
   The `history get` output includes per-step `duration` (in ms) and status.

3. For each step, extract: job name, step name, model name, duration, and
   status (succeeded/failed/skipped). For review steps that ran, include the
   VERDICT from the review log.

   **Timing**: Each step in the `history get` output has a `duration` field
   in milliseconds — use it directly as `durationMs`. For `totalDurationMs`,
   use the run's top-level `duration` field. Do NOT estimate or omit timing
   — the attestation must carry actual measured durations from the workflow
   run.

4. **NEVER reuse or edit a previous attestation.** Every attestation must be
   built from scratch using the actual data from the workflow runs for the
   current commit. Editing an old attestation to swap the commit SHA, run IDs,
   or any other field is a trust chain violation — the attestation would claim
   durations, timestamps, and config hashes from a different run against a
   different commit. Always query `workflow history get <run-id> --json` for
   each workflow, extract the real step durations and statuses, recompute
   config integrity hashes from the files at the verified commit
   (`sha256sum`), and construct a fresh JSON object.

5. Construct the combined attestation JSON:

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

6. Present the checklist AND the workflow run file paths to the user so they
   can inspect the full details:

   ```
   Build run:  .swamp/workflow-runs/<id>/workflow-run-<build-run-id>.yaml
   Review run: .swamp/workflow-runs/<id>/workflow-run-<review-run-id>.yaml
   ```

7. Determine the overall result. **Only call `verification_passed` when
   `gate.allPassed` is true — every non-skipped step must have succeeded.**
   If any step failed, call `verification_failed` instead. Do not treat a
   partial pass as success.

   - **All pass** → present checklist to user, wait for confirmation
   - **Any fail** → call `verification_failed`, fix the issues, re-verify

8. **Wait for the user to confirm they are ready to open the PR.** Present
   the full verification checklist and stop. Do NOT post the attestation or
   open a PR until the user explicitly says to proceed. The user's
   confirmation is the trigger for the attestation push.

9. **After the user confirms, post the attestation to swamp-club** using the
   issue-lifecycle model's `post_attestation` method. This is a **hard
   requirement** — the PR MUST NOT open until the attestation has been
   successfully posted.

   ```
   swamp model @swamp/issue-lifecycle method run post_attestation issue-<N> \
     --input attestation='<attestation JSON string>'
   ```

   The method uses the CLI's existing auth credentials (Bearer token from
   `~/.config/swamp/auth.json`). It throws on failure — if it fails, fix the
   auth or connectivity issue and retry.

   **If the POST fails, do NOT open a PR.** The attestation record in
   swamp-club is what CI validates — without it, the `validate-attestation`
   CI check will report "no attestation found."

   **If the POST succeeds**, the log output confirms the attestation ID and
   who posted it. A lifecycle entry is also recorded on the swamp-club issue.

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

Use `swamp data` with `--workflow` and `--run` flags to read step output
without needing model names. The run ID comes from the `workflow history
search` output.

List all data for a run:
```bash
SWAMP_WORKFLOWS_DIR=verification swamp data list \
  --workflow verify-build --run <run-id> --json
```

Get a specific data item (e.g. the log for a failed step):
```bash
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow verify-build --run <run-id> log --json
```

For review output, query the reviews workflow:
```bash
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow verify-reviews --run <run-id> log --json
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

Do NOT open a PR until the user has seen a fully green checklist,
confirmed they want to proceed, and the attestation has been posted to
swamp-club (step 9). The user's confirmation triggers the attestation
push — do not post it automatically.

## Review Prompts

Agent review prompts live at `verification/review-prompts/`. Each prompt is
read by the workflow step and combined with the diff. The prompts are the single
source of truth for review criteria — both the verification workflow and CI
reference them.
