# Adversarial Code Review Action

A reusable GitHub Action that runs an adversarial code review on pull requests
using Claude. Finds logic errors, security vulnerabilities, edge cases, and
failure modes that a standard review would miss.

## Usage

```yaml
name: Adversarial Review
on:
  pull_request:

jobs:
  adversarial-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: systeminit/swamp/.github/actions/adversarial-review@COMMIT_SHA
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

> **Pinning:** This action does not yet have a release/tag strategy. Pin to a
> specific commit SHA rather than `@main` to avoid unexpected changes.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github_token` | Yes | — | GitHub token with `pull-requests: write` permission |
| `anthropic_api_key` | Yes | — | Anthropic API key for Claude |
| `model` | No | `claude-opus-4-6` | Claude model to use |
| `conventions_file` | No | `CLAUDE.md` | Path to a project conventions file. If it exists, the reviewer reads it before reviewing. Set to `""` to skip. |
| `extra_dimensions` | No | `""` | Additional review dimensions to append (markdown with `##` headings and bullet points) |
| `allowed_tools` | No | *(see action.yml)* | Comma-separated list of allowed Claude Code tools |

## Review Dimensions

The action reviews code across seven built-in dimensions:

1. **Logic & Correctness** — code paths, edge cases, operator errors
2. **Error Handling & Failure Modes** — external call failures, silent swallowing, inconsistent state
3. **Security** — injection, path traversal, credential exposure, TOCTOU
4. **Concurrency & State** — race conditions, async ordering, deadlocks
5. **Data Integrity** — truncation, mutation, cache staleness, atomicity
6. **Resource Management** — leaks, unbounded loops, cleanup
7. **API Contract Violations** — signature changes, breaking changes, pattern inconsistencies

Add project-specific dimensions with the `extra_dimensions` input.

## Severity Levels

| Severity | Blocks Merge | Description |
|---|---|---|
| **CRITICAL** | Yes | Security vulnerabilities, data loss/corruption, production crashes |
| **HIGH** | Yes | Logic errors, resource leaks, unhandled failures in common paths |
| **MEDIUM** | No | Edge cases in uncommon paths, minor race conditions |
| **LOW** | No | Theoretical issues unlikely in practice |

## How It Works

1. Claude reads the project conventions file (if it exists) and every changed
   file in the PR
2. It systematically attempts to break the code across all review dimensions
3. It submits a GitHub review: `--comment` if clean, `--request-changes` if
   there are critical/high findings
4. The action fails the check if changes were requested, blocking the merge

## Adding Custom Dimensions

```yaml
- uses: systeminit/swamp/.github/actions/adversarial-review@COMMIT_SHA
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    extra_dimensions: |
      ## 8. Database Migration Safety
      - Are migrations reversible? Is there a rollback path?
      - Could the migration lock tables for too long in production?
      - Are there data backfill steps that could timeout?
```

## License

AGPL-3.0 — see [LICENSE](../../../COPYING) in the repository root.
