# Verification Conventions

## Container Sandbox

All verification runs inside the `swamp-club/verify` container. The container
provides an isolated environment matching CI conditions (Deno 2.8.3, Ubuntu,
git, unzip).

Mount the host's Deno cache for fast dependency resolution. If
`~/.config/swamp/verify.env` exists, pass it as `--env-file` so agent reviews
have access to `ANTHROPIC_API_KEY`:

```
docker run --rm \
  -v /path/to/repo:/path/to/repo \
  -v ~/Library/Caches/deno:/deno-dir \
  -e SWAMP_WORKFLOWS_DIR=verification \
  $([ -f ~/.config/swamp/verify.env ] && echo "--env-file $HOME/.config/swamp/verify.env") \
  -w /path/to/worktree \
  swamp-club/verify:deno-2.8.3 \
  workflow run verify-changes \
  --repo-dir /path/to/repo \
  --input commit=<SHA> \
  --input branch=<branch>
```

On Linux, the Deno cache is at `~/.cache/deno`.

### Agent review API key

Agent reviews (code-review, adversarial-review, ux-review, ci-security-review)
need an `ANTHROPIC_API_KEY` inside the container. Create the env file:

```
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/.config/swamp/verify.env
chmod 600 ~/.config/swamp/verify.env
```

The key is injected via `--env-file` at docker runtime and never enters the host
shell environment. Without it, agent reviews fail gracefully — build verification
(lint, test, compile) still works.

## Workflow Structure

The `verify-changes` workflow runs a DAG of verification steps:

**Tier 1 (parallel, no dependencies):**

- `static-analysis` — lint, fmt check, type check (via `@swamp/deno-runner`)
- `tests` — full test suite in parallel (via `@swamp/deno-runner`)
- `deps-audit` — vulnerability scan (via `@swamp/deno-runner`)

**Tier 2 (gated on tier 1 passing):**

- `compile` — build binary + binary-check (via `@swamp/deno-runner`)
- `code-review` — general review (via `@swamp/agent-runner`, own subprocess)
- `adversarial-review` — guarded on core path changes
- `ux-review` — guarded on CLI/presentation path changes
- `ci-security-review` — guarded on `.github/workflows/` changes

Each agent review runs in its own isolated subprocess. Build steps share the
container context.

## Attestation

On completion (pass or fail), the workflow produces a verification attestation
report. The attestation is a structured checklist showing every step, its
status, and retrieval commands for failed step output.

Read the attestation to determine next steps:

- **All pass** → call `verification_passed` with the checklist data
- **Any fail** → call `verification_failed`, fix the issues, re-verify

## Handling Failures

When verification fails:

1. Read the attestation to identify which steps failed
2. For failed build steps (lint, test, compile): fix the code directly
3. For failed agent reviews: read the review findings via
   `swamp data get <model> <data-name>`, address blocking findings, re-verify
4. Do NOT open a PR until all verification steps pass

## Review Prompts

Agent review prompts live at `verification/review-prompts/`. Each prompt
instructs the agent to `git diff main --name-only` and only review changed
files. The prompts are the single source of truth for review criteria — both
the verification workflow and CI reference them.
