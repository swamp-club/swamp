# Verification Conventions

## The submit-change Workflow

Verification is one workflow, `submit-change`, with three groups of jobs:
`verify-build`, `verify-reviews` and `verify-skills`. It replaced three
separately-launched workflows, which made "all three ran" a matter of agent
discipline and left three run ids to correlate by hand.

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run submit-change \
  --input commit=<SHA> \
  --input branch=<branch> \
  --input issue=<N>
```

One run covers all three groups, so `VerificationResultSchema.workflowRunId`
names the whole verification rather than one third of it.

### Targeted re-run

Each group has a boolean input defaulting to `true`. Deselecting one skips its
steps, and the attestation **carries that group's result forward** from the
most recent earlier run at the same commit where it passed.

That binding to the commit is what makes a subset re-run sound. If the code
moved, the deselected groups reviewed a different diff and their evidence is
stale regardless. At a fixed commit the opposite holds — an earlier run
examined the same tree, so its evidence is exactly as good as this run's. The
gate therefore asks "has every group passed for this commit?" rather than "did
every group run in this run?", which keeps a re-run after a flaky review cheap
without letting it ship on partial evidence.

The practical case is a group that failed for a non-code reason: Claude
overloaded, `TESSL_TOKEN` missing, a flaky test, a network blip. Re-run that
group alone; the rest carries.

`gate.allPassed` requires no failed step **and** every group having evidence,
so deselecting all three fails closed rather than producing a green gate over
zero steps. Each entry in `groups[]` names the run its evidence came from, and
a carried step is marked `fromRun`.

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow run submit-change \
  --input commit=<SHA> \
  --input branch=<branch> \
  --input issue=<N> \
  --input runBuild=false \
  --input runSkills=false
```

Every step in a group carries that group's `!inputs.runX` guard. A job whose
steps all skip still reports `succeeded`, so guarding only the group's setup
step would leave the rest of the group running against a worktree that was
never created. The setup step's guard is the group flag **alone** — that is
what distinguishes a deselected group (setup skipped) from a path guard
correctly excluding one review (setup succeeded, the review skipped).
`integration/verification_harness_rules_test.ts` pins both rules.

Path guards put the group flag first: `!inputs.runReviews || <path filter>`.
CEL short-circuits `||`, so a deselected group never reaches the `data.latest`
call for a diff its own `detect-changes` step skipped.

## Build Verification (verify-build group)

Build checks run on the host — native filesystem speed, same Deno that's
already installed. Isolation comes from a fresh `git worktree` at the verified
commit in `/tmp/swamp-verify-build-<run-id>`. Each run gets its own directory
(keyed by run ID, not commit SHA) so multiple verifications can run in parallel
without colliding.

The `build-setup` job creates the worktree, the build jobs run with
`workingDir` pointing at it, and a single `cleanup` job at the end of the
workflow removes all three worktrees regardless of pass/fail. Cleanup is one
job for all three groups, not one per group: under a shared run id a per-group
cleanup would delete another still-running group's `*-<run id>.yaml` model
definitions.

All steps use `command/shell` which correctly fails on non-zero exit code —
lint, test, and compile failures are reported accurately.

## Agent Reviews (verify-reviews group)

Reviews run on the host (not in a container) so the claude CLI has full project
context — CLAUDE.md, skills, and the codebase. Like the build group, reviews
run in a fresh `git worktree` at the verified commit
(`/tmp/swamp-verify-reviews-<run-id>`) so that `claude -p`'s Read/Glob/Grep
tools see the committed file state, not the caller's working tree.

The group:

1. Creates a clean worktree at the verified commit
2. Detects changed files via `@swamp/git` diff (full diff, then `nameOnly` for
   the file list used by guards)
3. Runs applicable reviews in parallel using `command/shell` steps that invoke
   `claude -p` with the review prompt + diff, with `workingDir` set to the
   worktree
4. Each review uses the factory pattern — one `reviewer` model, called once per
   review type with different prompt files and models
5. Review diffs use `git merge-base <diffBase> HEAD` so only the branch's own
   changes are reviewed — the setup step fetches the diff base first, when it
   is a remote ref, so it is current regardless of local branch state

### Stacked branches

`diffBase` defaults to `origin/main` and `prBase` to `main`. Set both when this
branch is stacked on another:

```
--input diffBase=cue/10-introduce-submit-change-workflow \
--input prBase=cue/10-introduce-submit-change-workflow
```

Without them the reviews diff against `main` and see the union of this branch
and its parent — re-reviewing everything the parent already had reviewed, at
four large-model calls, and burying the change actually under review. A local
parent branch needs no fetch, which is why the setup step only fetches a base
that looks like `origin/…`.

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
worktree, and **must** be named per-run *and per-group*
(`repo-reviews-${{ run.id }}`, `repo-skills-${{ run.id }}`) like the shell
models are — a step input for a global argument is persisted into the model's
stored definition, so a shared `repo` model hands one run's worktree path to
the next and two concurrent verifications race on it. Since consolidation the
two groups share a run id, so the group segment is what keeps the reviews
worktree path out of the skills diff. Guards reach that data with
`data.latest('repo-reviews-' + run.id, 'diff')`.

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

## Skill Verification (verify-skills group)

Skill checks follow the same worktree pattern as the build and review groups.
Isolation comes from a fresh `git worktree` at the verified commit in
`/tmp/swamp-verify-skills-<run-id>`.

The group detects changed files and guards both steps behind a skill-path
filter (`.claude/skills/**`, `CLAUDE.md`, `scripts/review_skills.ts`,
`evals/promptfoo/**`). When no skill files changed, both steps are skipped.

| Step | Command | Env Var | Missing Behavior |
| --- | --- | --- | --- |
| skill-review | `deno task review-skills` | `TESSL_TOKEN` | **Fails** (exit 1) — must be configured |
| skill-trigger-eval | `deno task eval-skill-triggers` | `ANTHROPIC_API_KEY` | Skipped (exit 0) if missing |

## Inspecting a Run

All three groups share one run, so there is one run id to find and one record
to read. Use `--input commit=<SHA>` to pick the right run when several
verifications are in flight:

```
# 1. Find the run ID for this commit
SWAMP_WORKFLOWS_DIR=verification swamp workflow history search \
  --workflow submit-change --input commit=<SHA> --json

# 2. Get detailed step data (duration, status, skip reason, data artifacts)
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <run-id> --json

# 3. Read step output (e.g. review findings or build errors)
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow submit-change --run <run-id> log --json
```

Every skipped step in that record carries a `skipReason`: `guarded` with the
expression that decided it, `dependency`, or `job_skipped`. A group that was
deselected shows its `*-setup` step skipped on `!inputs.runX`; a path guard
shows the filter expression on the individual review.

## The Attestation

The attestation is generated by the `attest` step of the run it describes, from
what that run has already persisted. `scripts/build_attestation.ts` reads the
run record back through `swamp workflow history get`, hashes the config files
at the verified commit with `git show`, and writes the document to stdout.

**Do not construct, edit or reuse an attestation by hand.** The agent used to
assemble it from the run records it had just produced, which made the party
that performed verification and the author of the document attesting to it the
same party — an agent writing its own attestation is indistinguishable from one
fabricating it. There is nothing left for an agent to fill in: every field is a
function of the run record, the workflow definition at the verified commit, and
hashes of that commit's files.

The step refuses to attest when the commit it is asked to name differs from the
commit the run was launched with, so an attestation cannot describe work nobody
did.

### What it carries

| Field | Source |
| --- | --- |
| `subject.commit` / `subject.branch` | The run's own inputs |
| `steps[]` | Every step of the three verification groups: status, `durationMs`, `skipKind`, `skipExpression` |
| `steps[].verdict` | `pass` on a succeeded review. The step status *is* the gate decision — `check_review_verdict.ts` decides both |
| `groups[]` | Per group: `selected` (the boolean input), `ran` (evidence exists for this commit), `evidenceFrom` (the run that examined the code), `carriedForward`, and the reason when it did not run here |
| `reviewConfig` | Each review's claude model, read out of the review step's own shell at the verified commit |
| `configIntegrity` | sha256 of CLAUDE.md, AGENTS.md, the review prompts, the workflow, and the verdict and attestation scripts, all as they stand at the verified commit |
| `gate` | Pass/fail counts, `skippedByKind` so a guard skip and a deselected group are not one number, and `groupsWithEvidence`/`groupsTotal`. `allPassed` needs both: no failed step, and every group covered |
| `generatedBy` | `workflow-step` — stated, not inferred |

The `configIntegrity` section proves the prompts, workflow and scripts used
match the versions at the verified commit. Anyone can check out that commit,
hash the files, and compare; CI does exactly that. Its list and the `check_hash`
calls in `.github/workflows/ci.yml` have to stay in step — a hash the
attestation omits is reported by CI as a warning, not silently ignored.

## Publishing

The `publish-attestation` job posts the document through the issue's
`@swamp/issue-lifecycle` instance. The `attestation` input is an expression
over the attest step's recorded output, so the only thing that can reach
swamp-club is what the attest step actually wrote:

```yaml
attestation: "${{ data.latest('submit-attest-' + run.id, 'result').attributes.stdout }}"
```

`post_attestation` writes an `attestationRecord` resource from the
attestation's own fields — never from separate arguments, since a caller that
could state the commit alongside the document could state a different one. That
receipt is what the PR depends on.

## Opening the Pull Request

`gh pr create` used to appear in exactly one file in the repo — a skill
instructing the agent — so no check on `link_pr` could prevent an unattested
PR: by the time `link_pr` ran, the PR already existed, and every gate-based fix
sat downstream of the act it guarded.

The `open-pr` job takes the attestation id as an **input**, read from the
`attestationRecord` that `post_attestation` writes only when swamp-club accepts
the document. No accepted attestation, no id, no step. The illegal state is not
rejected; it cannot be expressed.

Three details the job is deliberate about:

- It pushes `<commit>:refs/heads/<branch>`, not the branch tip. The attestation
  is bound to a SHA; pushing whatever HEAD has become would let a commit made
  after verification reach the PR under an attestation that never saw it. A
  non-fast-forward push fails loudly, which is correct — it means history was
  rewritten under an attestation describing the old history.
- **It opens or updates.** Re-running is the normal case, not an edge case: CI
  validates that the attestation's commit equals the PR head, so every push to
  an open PR needs a fresh attestation for the new SHA, and the `pr_failed`
  recovery loop re-verifies against a PR that is already open. `gh pr create`
  refuses a second PR for the same branch, so the step looks for an open one
  first and comments the new attestation id on it instead. Commenting rather
  than rewriting the body preserves human edits and leaves one entry per
  attestation — the audit trail of which commits were verified and when.
- `link_pr` takes its URL from the create-PR step's recorded output, so the
  lifecycle records what the run produced rather than what an agent typed.
  `link_pr` is idempotent, so a re-run bumps `attempt` on the same URL.

Everything past `record-verification` runs only when verification actually
passed. `attest` runs on failure too — an attestation recording a failure is
worth having — so the pass/fail decision lives on the group jobs, with
`or(succeeded, skipped)` rather than `succeeded`, because a deselected group
reports `skipped` and must not read as a failure.

`integration/verification_harness_rules_test.ts` pins all of this: that
`create-pr` reads `attestationRecord-main`, that `link-pr` reads the create
step's output, and that `record-verification` passes the attestation rather
than a step list of its own.

## Commit Binding

The run's first job calls `verify`, so the workflow establishes its own
precondition rather than depending on the caller having moved the phase. That
matters twice: `verification_passed` is legal only from `verifying`, so a run
launched without it would burn the whole verification and fail at the end; and
each run refreshes the recorded commit, so a re-run on a new commit compares its
own records against its own commit. `verify` accordingly accepts
`implementing`, `verifying`, `pr_open` and `pr_failed` — refreshing the
record used to require marking a healthy PR failed first.


`verify` persists what it was started for as `verificationTarget-main`. Before
that it took a commit and a branch and dropped both, so `verification_passed`
asked for them again with nothing comparing the two, and `verification-clear`
read only pass/fail counts — a result belonging to an earlier commit satisfied
it.

`verification-clear` and `attestation-posted` now both assert their record
names that commit. A lifecycle with no target predates the resource and is
admitted, since there is nothing to compare and stranding it would force a
re-verification of finished work.

What this does **not** close: the commit is still whatever the caller passed to
`verify`, and nothing reads HEAD, so a record that is stale relative to the
working tree still passes. Verify A, commit B, link without re-verifying, and
every record agrees with the target. Catching that needs the check to resolve
HEAD — the first model check that would run a process — and is deliberately
left open rather than papered over.

Both gates also apply to `complete`, which transitions the swamp-club issue to
`shipped`. `complete` is reachable from `implementing`, where there may be no
code to verify, so it takes a `reason` argument that opens the escape and is
recorded on the issue. `link_pr` has no such escape.

## Presenting the Result

Read the run and show the user what happened:

```
SWAMP_WORKFLOWS_DIR=verification swamp workflow history get <run-id> --json
```

Present every step with its status, model, duration, and for skipped steps the
recorded reason, then the PR the run opened. Include the run file path so the
user can inspect the raw data.

The run already recorded the checklist: `record-verification` calls
`verification_passed` with the attestation, which derives the commit, branch,
run id and step list from it. Do not call `verification_passed` by hand on this
path — and note it refuses an attestation whose gate did not pass.

When verification fails, `record-verification` and everything after it skip, so
no attestation is published and no PR opens. Present the failures and call
`verification_failed` with a summary; that transitions back to `implementing`.

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
  --workflow submit-change --run <run-id> --json
```

Get a specific data item (e.g. the log for a failed step):
```bash
SWAMP_WORKFLOWS_DIR=verification swamp data get \
  --workflow submit-change --run <run-id> log --json
```

Build, review and skill output all live under the same run, so there is one
place to look regardless of which group failed.

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

Commit the fixes, then re-run the workflow:

```bash
SWAMP_WORKFLOWS_DIR=verification swamp workflow run submit-change \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current) \
  --input issue=<N>
```

Re-run everything unless you can say why a group cannot be affected by the
fix. When you can, deselect it — `--input runSkills=false` — and the skipped
steps record `!inputs.runSkills` as their reason, so the attestation says the
group was deselected rather than silently counting three more skips.

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

Do NOT open a PR by hand. The workflow publishes the attestation and the
`attestation-posted` check on `link_pr` refuses a PR that has no published
attestation behind it.

## Review Prompts

Agent review prompts live at `verification/review-prompts/`. Each prompt is
read by the local verification workflow step and combined with the diff. The
prompts are the single source of truth for review criteria. CI does not run
these reviews — it validates that local verification ran via the attestation.
