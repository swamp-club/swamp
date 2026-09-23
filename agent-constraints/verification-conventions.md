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
   the diff base is current regardless of local branch state, retrying once
   because parallel verifications race to update the shared ref
6. Cleans up the worktree regardless of pass/fail

### Guards

Reviews are guarded by file path — they skip when no relevant files changed:

| Review | Guard (run when any match) | Model |
| --- | --- | --- |
| code-review | always | claude-opus-4-6 |
| adversarial-review | `src/cli/`, `src/domain/`, `src/infrastructure/`, `src/libswamp/`, `src/serve/`, `src/worker/` | claude-opus-4-6 |
| ux-review | `src/cli/commands/`, `src/presentation/`, `src/domain/errors.ts`, `src/libswamp/` | claude-sonnet-4-6 |
| ci-security-review | `.github/workflows/` | claude-opus-4-6 |

The guards filter the changed-file list produced by the `detect-changes` job.
Those `@swamp/git` steps **must** pass `repoPath` pointing at the verification
worktree, and **must** be named per-run (`repo-${{ run.id }}`) like the shell
models are — a step input for a global argument is persisted into the model's
stored definition, so a shared `repo` model hands one run's worktree path to the
next and two concurrent verifications race on it. Guards reach that data with
`data.latest('repo-' + run.id, 'diff')`.

They **must** also pass `threeWay: true`, making the diff `origin/main...HEAD`
— merge-base relative, matching the `git merge-base` the review steps compute.
A two-dot diff is taken against the *moving* `origin/main` tip, so every commit
that lands on main after a branch forks joins the changed-file list: a branch
touching only YAML was observed firing the `src/`-guarded reviews on 34
unrelated files. The list the guards filter and the diff the reviews read have
to be the same set of changes. `repoPath` defaults to `.`, so a step without it diffs the checkout
the workflow was launched from rather than the commit being verified — and that
checkout is usually clean and sitting on `origin/main`, which yields an empty
file list. An empty list makes every `.size() == 0` guard true, so every guarded
review skips while the workflow still reports success. The failure is silent and
leaves an attestation that records a verification which never examined the code.

When adding a guarded step, confirm the guard actually fires: run the workflow
against a branch you know touches the guarded paths and check the step status is
`succeeded` rather than `skipped`.

### Authentication

The claude CLI authenticates via one of two methods:

1. **`~/.config/swamp/verify.env`** — if this file exists with
   `ANTHROPIC_API_KEY=sk-ant-...`, export it before running the workflow.
2. **claude.ai login** — if no env file exists, the CLI uses your existing
   claude.ai login. No additional setup needed.

The skill verification workflow also needs:

- **`TESSL_TOKEN`** — for `deno task review-skills` (calls `npx tessl`). Add it
  to `verify.env`. If missing, skill review **fails** (exit 1) — an incomplete
  verification is not a valid attestation.
- **`ANTHROPIC_API_KEY`** — for `deno task eval-skill-triggers` (calls the
  Anthropic API). Already available from `verify.env` or claude.ai login. If
  missing, trigger evals are skipped gracefully (exit 0).

To create the env file (optional):

```
cat > ~/.config/swamp/verify.env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
TESSL_TOKEN=tsk-...
EOF
chmod 600 ~/.config/swamp/verify.env
```

## Skill Verification (Host Workflow)

Skill checks run as a swamp workflow on the host, following the same worktree
pattern as the build and review workflows. Isolation comes from a fresh
`git worktree` at the verified commit in `/tmp/swamp-verify-skills-<run-id>`.

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-skills \
  --input commit=<SHA> \
  --input branch=<branch>
```

The workflow detects changed files and guards both steps behind a skill-path
filter (`.claude/skills/**`, `CLAUDE.md`, `scripts/review_skills.ts`,
`evals/promptfoo/**`). When no skill files changed, both steps are skipped.

| Step | Command | Env Var | Missing Behavior |
| --- | --- | --- | --- |
| skill-review | `deno task review-skills` | `TESSL_TOKEN` | **Fails** (exit 1) — must be configured |
| skill-trigger-eval | `deno task eval-skill-triggers` | `ANTHROPIC_API_KEY` | Skipped (exit 0) if missing |

## Running All Three in Parallel

The agent launches the build, review, and skill workflows simultaneously. All
three must pass for verification to succeed.

After each workflow completes, present the commands to the user so they can
inspect the attestations. Use `--input commit=<SHA>` to find the correct run
when multiple verifications run in parallel:

```
# 1. Find the run IDs for this commit
SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
  --workflow verify-build --input commit=<SHA> --json
SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
  --workflow verify-reviews --input commit=<SHA> --json
SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
  --workflow verify-skills --input commit=<SHA> --json

# 2. Get detailed step data (duration, status, data artifacts)
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <build-run-id> --json
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <reviews-run-id> --json
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <skills-run-id> --json

# 3. Read step output (e.g. review findings or build errors)
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow verify-reviews --run <reviews-run-id> log --json
```

## Verification Checklist

After all three workflows complete, the agent constructs a **combined
verification checklist** from the workflow run outputs and presents it to the
user. This is the single view of everything that ran.

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
  ✓ review           review-code       87.0s   GATE_VERDICT: pass

○ Adversarial Review
  ○ review           review-adversarial  —     skipped (no core changes)

○ UX Review
  ○ review           review-ux           —     skipped (no UX changes)

○ CI Security Review
  ○ review           review-ci-security  —     skipped (no workflow changes)

✓ Skill Review
  ✓ skill-review     skills-review      5.2s
  ✓ skill-trigger-eval skills-trigger-eval 42.0s

Gate: 10/10 passed, 3 skipped (guard)
Total: 2m 15s
```

To construct this checklist:

1. Find the run IDs for this commit:
   ```
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
     --workflow verify-build --input commit=<SHA> --json
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
     --workflow verify-reviews --input commit=<SHA> --json
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
     --workflow verify-skills --input commit=<SHA> --json
   ```
   The `--input commit=<SHA>` filter ensures you get the correct run when
   multiple verifications run in parallel across worktrees.

2. Get detailed step data for each run:
   ```
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <build-run-id> --json
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <reviews-run-id> --json
   SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <skills-run-id> --json
   ```
   The `history get` output includes per-step `duration` (in ms) and status.

3. For each step, extract: job name, step name, duration and status. For a
   review step that ran, the verdict is the step's status —
   `check_review_verdict.ts` decides both, so the reviewer's own prose is the
   input to that decision rather than the decision itself.

   **Timing**: each step in the `history get` output has a `duration` field in
   milliseconds. Use it directly; never estimate.

4. Build the attestation with the generator. Do NOT assemble it by hand:

   ```
   deno run build-attestation \
     --run <build-run-id> --run <reviews-run-id> --run <skills-run-id> \
     --commit <SHA> --branch <branch> > /tmp/attestation.json
   ```

   The three run ids may be given in any order — the generator reads each
   record's own `workflowName` to tell them apart, so mislabelling one is not
   a mistake you can make. It projects every field from what the runs
   recorded: step statuses and durations, each review's model and why a
   skipped one did not run, and SHA-256 of every file that shaped the
   verification read at the verified commit with `git show`. It refuses to
   write anything when a run examined a different commit than the one being
   attested to, or executed a workflow other than that commit's — a relative
   `SWAMP_WORKFLOWS_DIR` resolves against `--repo-dir`, so from a worktree set
   it to the worktree's absolute `verification/` path. It validates its own
   output against `AttestationSchema` before it prints.

   This replaces roughly seventy lines of instructions that used to live here,
   telling you how to read the records, hash the files, work out which reviews
   were guarded out, and assemble the JSON. Reconstructed from prose each
   time, it came out slightly different each time. The shape now lives in
   `AttestationSchema` (`extensions/models/_lib/schemas.ts`), and both the
   generator and `post_attestation` enforce it.

   What the generator does not do is make the attestation trustworthy: it runs
   wherever you run it, and nothing yet stops a document being posted that it
   did not write. `post_attestation` will reject one that does not match the
   schema, which is a check on shape, not on provenance.

5. **NEVER reuse or edit a previous attestation.** Re-run the generator
   against the current commit's runs. Editing an old attestation to swap the
   commit SHA or run ids is a trust chain violation — the document would claim
   durations, timestamps and config hashes from a different run against a
   different tree. The generator's commit binding catches the obvious form of
   this; hand-editing its output defeats it.

6. Present the checklist AND the workflow run file paths to the user so they
   can inspect the full details:

   ```
   Build run:  .swamp/workflow-runs/<id>/workflow-run-<build-run-id>.yaml
   Review run: .swamp/workflow-runs/<id>/workflow-run-<review-run-id>.yaml
   Skills run: .swamp/workflow-runs/<id>/workflow-run-<skills-run-id>.yaml
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
     --input attestation="$(cat /tmp/attestation.json)"
   ```

   The method validates the document against `AttestationSchema` before it
   dials out, so a malformed one fails here rather than in CI after the PR is
   public. If it reports a schema mismatch, re-run the generator — do not
   patch the JSON to satisfy the error.

   The method uses the CLI's existing auth credentials (Bearer token from
   `~/.config/swamp/auth.json`). It throws on failure — if it fails, fix the
   auth or connectivity issue and retry.

   **If the POST fails, do NOT open a PR.** The attestation record in
   swamp-club is what CI validates — without it, the `validate-attestation`
   CI check will report "no attestation found."

   **If the POST succeeds**, the log output confirms the attestation ID and
   who posted it. A lifecycle entry is also recorded on the swamp-club issue.

## Verifying TTY-Only Behaviour

Some behaviour is reachable only when stdin is a terminal, and an agent shell is
not one. `initializeLogging` is the live example: `prettyOutput` is
`!noColor && isStdinTty()`, so a TTY session uses the pretty sink while a
scripted run uses the plain console sink — two different code paths, and a bug
can live in the one a script never touches (swamp-club#2254).

Do not record this as "needs a human at a terminal." `script` supplies a real
pty on stdin while the command's stdout and stderr still go where you point
them, so the two streams stay separable:

```bash
script -q /dev/null /bin/sh -c "
  swamp <command> -v > /tmp/out.txt 2> /tmp/err.txt
"
cat -A /tmp/out.txt   # -A shows line endings, so a stray blank line is visible
cat /tmp/err.txt
```

Inside the `script` subshell, `tty` confirms stdin really is a terminal — worth
asserting once, since a harness that silently drops the pty would otherwise make
the check pass vacuously.

Run the same harness against the **released** binary as well as the built one.
Two runs that differ only in the binary are what distinguish a fix from a test
that was always going to pass:

```
# shipped:   stdout carries the pretty debug record, then the URL
# built:     stdout carries the URL alone
```

The same technique covers anything else gated on an interactive terminal —
prompts from `src/cli/prompt_helpers.ts`, Ink components, and any renderer
branching on `Deno.stdout.isTerminal()`.

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
- **Skill review failures**: "Skill review scored below 90% threshold. I'll
  update the skill and re-run verification."
- **Skill trigger eval failures**: "Trigger eval pass rate below threshold.
  I'll fix the trigger config and re-run verification."

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

For skill check output, query the skills workflow:
```bash
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow verify-skills --run <run-id> log --json
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
- **Skill review failures**: update the skill content to improve the review
  score, run `deno run review-skills` locally to verify
- **Skill trigger eval failures**: check trigger config in
  `evals/promptfoo/`, run `deno run eval-skill-triggers` locally to verify

### 4. Re-run verification

Commit the fixes, then re-run BOTH verification workflows:

```bash
SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-build \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)

SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-reviews \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)

SWAMP_WORKFLOWS_DIR=verification swamp workflow run verify-skills \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current)
```

### 5. Repeat until green

Repeat steps 1–4 until all build steps pass, all reviews pass, and all skill
checks pass or are skipped. Present the full verification checklist to the user
after each run.

A review step fails immediately if `claude -p` exits non-zero. Every other
outcome is decided by `scripts/check_review_verdict.ts`, which each review step
invokes with the review output and its label. That script is the only place the
rule lives — the steps own the reviewer invocation, it owns the decision — and
it writes its decision to the log as `GATE_VERDICT: <pass|fail|missing|
provider-error>`.

A review passes **only** when it outputs an explicit `VERDICT: pass` marker at
the start of a line. Nothing is inferred:

- **Provider errors** (usage-limit, rate-limit, auth, or overload messages) mean
  no review ran, and are detected before any marker — a provider error that
  happens to carry a marker still fails.
- **A missing marker fails the step.** A reviewer that does not answer in the
  required format is precisely when a human should look, so the verdict is
  recorded as `missing` rather than guessed in either direction. Empty or
  trivially short output (<50 bytes) is reported as missing too, distinguished
  only in the error message.
- **Only a line-initial marker counts.** The reviewer is told to begin its
  response with the marker, so a mention inside a sentence — a reviewer weighing
  out loud whether to emit pass or fail — is not a verdict. Markdown emphasis
  around the marker is tolerated.

Expect this to block more often than the old inference did. That is the point:
before swamp-club#2265 a review reporting two blocking findings in prose was
recorded as a pass, because the inference defaulted that way.

Do NOT open a PR until the user has seen a fully green checklist,
confirmed they want to proceed, and the attestation has been posted to
swamp-club (step 9). The user's confirmation triggers the attestation
push — do not post it automatically.

## Review Prompts

Agent review prompts live at `verification/review-prompts/`. Each prompt is
read by the local verification workflow step and combined with the diff. The
prompts are the single source of truth for review criteria. CI does not run
these reviews — it validates that local verification ran via the attestation.
