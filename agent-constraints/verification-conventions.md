# Verification Conventions

## Container Sandbox

Verification uses two separate containers running in parallel:

1. **Build container** — lint, test, compile, deps audit. No API keys.
2. **Review container** — agent code reviews with `ANTHROPIC_API_KEY`.

Both use the `swamp-club/verify` container image (Deno 2.8.3, Ubuntu, git,
unzip). The agent launches both `docker run` commands simultaneously.

### Build container

```
docker run --rm \
  -v /path/to/repo:/path/to/repo \
  -v ~/Library/Caches/deno:/deno-dir \
  -e SWAMP_WORKFLOWS_DIR=verification \
  -w /path/to/worktree \
  swamp-club/verify:deno-2.8.3 \
  workflow run verify-build \
  --repo-dir /path/to/repo \
  --input commit=<SHA> \
  --input branch=<branch>
```

### Review container

```
docker run --rm \
  -v /path/to/repo:/path/to/repo \
  -v ~/Library/Caches/deno:/deno-dir \
  -e SWAMP_WORKFLOWS_DIR=verification \
  --env-file ~/.config/swamp/verify.env \
  -w /path/to/worktree \
  swamp-club/verify:deno-2.8.3 \
  workflow run verify-reviews \
  --repo-dir /path/to/repo \
  --input commit=<SHA> \
  --input branch=<branch>
```

On Linux, the Deno cache is at `~/.cache/deno`.

### Agent review API key

Agent reviews (code-review, adversarial-review, ux-review, ci-security-review)
need an `ANTHROPIC_API_KEY` inside the review container. Create the env file:

```
echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/.config/swamp/verify.env
chmod 600 ~/.config/swamp/verify.env
```

The key is injected via `--env-file` at docker runtime and never enters the host
shell environment or the build container. Without the file, skip the review
container — build verification still works independently.

## Workflow Structure

Two workflows run in parallel in separate containers:

### verify-build (build container, no API key)

- `static-analysis` — lint, fmt check, type check (via `@swamp/deno-runner`)
- `tests` — full test suite (via `@swamp/deno-runner`)
- `deps-audit` — vulnerability scan (via `@swamp/deno-runner`)
- `compile` — build binary + binary-check (gated on static-analysis + tests)

### verify-reviews (review container, with API key)

- `detect-changes` — `@swamp/git` diff against main
- `code-review` — general review (gated on detect-changes)
- `adversarial-review` — guarded on core path changes
- `ux-review` — guarded on CLI/presentation path changes
- `ci-security-review` — guarded on `.github/workflows/` changes

Reviews receive the full diff inline via the `diff` input — the agent reviews
the diff directly without reading files from the repo.

## Attestation

On completion (pass or fail), each workflow produces a verification attestation
report. The attestation is a structured checklist showing every step, its
status, and retrieval commands for failed step output.

Both attestations must pass for the verification to succeed.

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
receives the diff inline and reviews the changes directly. The prompts are the
single source of truth for review criteria — both the verification workflow and
CI reference them.
