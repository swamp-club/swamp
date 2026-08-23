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
swamp workflow run verify-reviews \
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

The agent launches the build container and the review workflow simultaneously.
Both must pass for verification to succeed.

## Attestation

On completion (pass or fail), each verification produces results. The build
workflow produces a structured attestation report. Reviews produce pass/fail
verdicts with findings.

Both must pass for the verification to succeed.

Read the results to determine next steps:

- **All pass** → call `verification_passed` with the checklist data
- **Any fail** → call `verification_failed`, fix the issues, re-verify

## Handling Failures

When verification fails:

1. Read the workflow attestation output to identify which steps failed. Note:
   the `@swamp/deno-runner` model currently reports step status as "succeeded"
   even on non-zero exit. Check the `exitCode` tag in each step's data to
   determine the real result.

2. For failed build steps, read the step's captured output:

   ```bash
   # List data for a specific model (e.g. lint, tests, compile)
   swamp data list <model-name>

   # Read the output — stderr contains the error details
   swamp data get <model-name> <data-name> --json
   ```

   The `stderr` field contains the full command output including which tests
   failed, lint errors, or compile errors. The `exitCode` field confirms
   pass (0) or fail (non-zero).

3. For failed agent reviews, read the review findings:

   ```bash
   swamp data get cli-reviewer log
   ```

   The log contains the full review text with blocking issues and suggestions.

4. Fix the issues identified in the output, then re-verify. Repeat until all
   steps pass with `exitCode: 0` and all reviews return `VERDICT: pass`.

5. Do NOT open a PR until all verification steps pass.

## Review Prompts

Agent review prompts live at `verification/review-prompts/`. Each prompt is
read by the workflow step and combined with the diff. The prompts are the single
source of truth for review criteria — both the verification workflow and CI
reference them.
