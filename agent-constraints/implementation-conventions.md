# Implementation Conventions

## Verification (Bugs and Regressions Only)

If a reproduction was created during triage, reuse it to confirm the fix works.

a. **Recompile swamp** with the fix:

```
deno run compile
```

This produces a `./swamp` binary in the repo root.

b. **Re-run the reproduction scenario** in the scratch repo using the locally
compiled binary — **not** the `swamp` on PATH:

```
cd /tmp/swamp-repro-issue-<N>
/path/to/repo/swamp <same commands from reproduction>
```

Use the absolute path to the compiled binary (e.g.
`/Users/.../swamp/.claude/worktrees/issue-lifecycle/swamp`).

c. **Confirm the fix.** The previously failing scenario should now succeed. If
it still fails, the fix is incomplete — go back and fix the code.

d. **Report verification results** to the human before creating the PR:

- "Verified: reproduction scenario now passes" or
- "Verification failed: <what still breaks>"

## Creating PRs

Use the `github-pr` skill to create pull requests.
