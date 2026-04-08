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

## 4a. Link the PR

After the PR is open, record its URL on the lifecycle so the swamp-club record
points to where the fix lives:

```
swamp model method run issue-<N> link_pr --input url=<PR URL>
```

This writes a `pullRequest-main` resource, transitions the phase to `pr_open`,
and posts a `pr_linked` lifecycle entry on the swamp-club issue. The swamp-club
status stays at `in_progress` — there is no new status for `pr_open`; the PR
link is additional evidence attached to the in-progress state.

`link_pr` is **idempotent** — call it again with a new URL if:

- CI fails and you force-push a different PR
- The first PR is closed and a replacement is opened
- You recorded the wrong URL the first time

Each call overwrites `pullRequest-main` with the latest URL and refreshes
`linkedAt`. A new `pr_linked` entry is posted on every call.

Calling `link_pr` is **encouraged but not enforced** — `complete` still accepts
`implementing` as a valid source phase for backwards compatibility with legacy
records. Prefer the `implementing → link_pr → complete` flow for all new work so
the lifecycle record carries the PR link.

## 5. Complete the Issue

Once the PR has merged and the work is done, call `complete`:

```
swamp model method run issue-<N> complete
```

This transitions the phase to `done`, transitions the swamp-club status to
`shipped`, and posts a `complete` lifecycle entry.
