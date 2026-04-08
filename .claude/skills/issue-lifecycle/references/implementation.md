# Implementation Flow

Read this after the plan is approved and the human says to implement. The
`approve` method already transitioned the swamp-club issue to `in_progress`.

## 1. Signal Implementation Started

Before writing any code, signal that implementation has begun:

```
swamp model method run issue-<N> implement
```

This transitions the phase to `implementing` and posts an
`implementation_started` lifecycle entry on the swamp-club issue. Do this
**before** touching any code.

## 2. Do the Implementation Work

Follow the approved plan step by step.

## 3. Verify the Fix Against the Reproduction

**Bugs and regressions only — skip for features and security issues.**

If a reproduction was created during triage, reuse it to confirm the fix works.

Read `agent-constraints/implementation-conventions.md` at the repo root for
repo-specific verification steps (build commands, binary paths, test commands).
If it does not exist, use the project's standard build/test process from
CLAUDE.md.

Report verification results to the human before creating the PR:

- "Verified: reproduction scenario now passes" or
- "Verification failed: <what still breaks>"

## 4. Create a PR

Use the repository's normal PR tooling. Read
`agent-constraints/implementation-conventions.md` for repo-specific PR
conventions.

The issue-lifecycle model does not track PRs directly — your PR creation is
outside the model's scope. The swamp-club issue status stays at `in_progress`
until you call `complete`.

## 5. Complete the Issue

Once the PR has merged and the work is done, call `complete`:

```
swamp model method run issue-<N> complete
```

This transitions the phase to `done`, transitions the swamp-club status to
`shipped`, and posts a `complete` lifecycle entry.
