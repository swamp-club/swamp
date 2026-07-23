# Swamp Share Skill

Guide a solo swamp user through promoting their repo so a teammate can clone and
collaborate. State machine with gates — do not advance until the current state's
**Verify** passes.

```
assess → datastore (gate) → vaults (gate) → commit → joiner instructions
```

## CRITICAL Rules

- **Never skip the assess step.** Always show the checklist first — it is the
  anchor for every invocation.
- **Never run commands silently.** Show the user what you are about to run and
  explain why before executing.
- **Resume from partial state.** If the user returns mid-flow, re-run the assess
  step to detect current state and pick up where they left off.
- **Prefer interactive commands over flag assembly.** Use
  `swamp datastore setup` and `swamp vault migrate <vault>` without flags — they
  launch interactive wizards. Only fall back to explicit flags when the user
  provides all config upfront or when re-running a failed command with the same
  arguments.
- **On failure, re-run the exact same command.** When a command fails (e.g.
  credential error), save the full command string. After the user fixes the
  issue, re-run that saved command verbatim — do not re-assemble it from
  conversation context, as that risks typos and drift.
- **Check provider auth before migration.** Before running
  `swamp vault migrate`, verify the target provider's CLI/credentials are
  working (e.g. `op whoami` for 1Password, `aws sts get-caller-identity` for
  AWS). Surface the auth requirement and let the user fix it before attempting
  the migration.
- **Verify CLI syntax**: If unsure about exact flags, run `swamp help <command>`
  for the up-to-date schema.
- **VCS detection**: Check for `.jj` directory to determine if the repo uses
  jujutsu or git. Hand off to the `jujutsu` skill or `github-pr` skill
  accordingly for the commit step.

## Quick Reference

| Task                   | Command                                     |
| ---------------------- | ------------------------------------------- |
| Check datastore status | `swamp datastore status --json`             |
| List vault types       | `swamp vault type search --json`            |
| List vaults            | `swamp vault search --json`                 |
| Set up datastore       | `swamp datastore setup` (interactive)       |
| Migrate a vault        | `swamp vault migrate <vault>` (interactive) |
| Check git remote       | `git remote -v`                             |
| Run diagnostics        | `swamp doctor datastores --json`            |

## State 1: assess

**Gate:** None (first state).

**Action:** Gather current repo state and show a checklist:

```bash
swamp datastore status --json        # current datastore type + health
swamp vault search --json            # all vaults and their types
git remote -v                        # git remote configured?
```

Present as a checklist:

- ✓/✗ Git remote configured
- ✓/✗ Datastore is external (not filesystem at `.swamp/`)
- ✓/✗ Each vault's provider type (green if not `local_encryption`)

**Already shareable:** If datastore is external AND no vaults are
`local_encryption`, say: "This repo is already shareable." Offer to generate
joiner instructions (skip to State 5).

**Verify:** Checklist is displayed and the user sees what needs to change.

## State 2: datastore (gate)

**Gate:** State 1 passed, datastore is `filesystem` at the default `.swamp/`
path.

**Skip:** If the datastore is already external, skip to State 3.

**Action:** Ask the user where they want to store data. Once you have the choice
and config details, build a single `swamp datastore setup` command and run it.
Save the exact command string — if it fails, you will re-run it verbatim after
the user fixes the issue.

Before building the command, ask: **"Will other repos share this datastore?"**
If yes, ask for a namespace slug (lowercase alphanumeric + hyphens, e.g.
`infra`) and add `--namespace <slug>` to the `setup extension` command. This
assigns the namespace during setup in one step — no separate `namespace set` +
`namespace migrate` needed.

| Choice                      | Command                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| AWS S3                      | `swamp datastore setup extension @swamp/s3-datastore [--namespace <slug>] --config '{"bucket":"…","region":"…"}'`   |
| Google Cloud Storage        | `swamp datastore setup extension @swamp/gcs-datastore [--namespace <slug>] --config '{"bucket":"…"}'`               |
| S3-compatible (MinIO, etc.) | Same as S3 but add `"endpoint":"http://…","forcePathStyle":true` to config                                          |
| Shared filesystem           | `swamp datastore setup filesystem --path <path>`                                                                    |
| Other                       | `swamp extension search <keyword> --label datastore` → then `swamp datastore setup extension <type> --config '{…}'` |

**Verify:** `swamp datastore status --json` shows the new type and
`healthy: true`.

**On Failure:** The most common failure is a credential or access error (403,
connection refused). When this happens:

1. Explain what the error means and what the user needs to fix
2. **Save the exact command** you ran
3. Wait for the user to say they've fixed it
4. **Re-run the saved command verbatim** — do not rebuild it from conversation
5. If it fails again, consult
   [references/troubleshooting.md](references/troubleshooting.md)

## State 3: vaults (gate, per vault)

**Gate:** State 2 passed (or skipped).

**Skip:** If no vaults exist, or no vaults use `local_encryption`, skip to
State 4.

**Action:** For each vault on `local_encryption`:

1. Ask which provider to migrate to (AWS Secrets Manager, Azure Key Vault,
   1Password, or search for another)
2. **Pre-flight auth check** — verify the provider's credentials are working
   before attempting the migration:
   - 1Password: `op whoami`
   - AWS Secrets Manager: `aws sts get-caller-identity`
   - Azure Key Vault: `az account show`
   - If the check fails, tell the user what to set up and wait
3. Build the migration command:
   `swamp vault migrate <vault> --to-type <type> --config '{...}' --force` Use
   `--force` to skip the interactive confirmation (you already confirmed with
   the user conversationally).
4. If the user says "same for all", batch the remaining vaults with the same
   type and config.

The user can skip individual vaults ("I'll do that later") — show them as ✗ in
the checklist on the next assess.

**Verify:** `swamp vault search --json` shows migrated vaults with the new type.

**On Failure:** Save the exact command. Most failures are auth-related — the
pre-flight check should catch these, but if not, explain the error, wait for the
fix, and re-run the saved command. See
[references/troubleshooting.md](references/troubleshooting.md).

## State 4: commit

**Gate:** State 3 passed (or skipped).

**Action:** Show which files changed and why:

- `.swamp.yaml` — datastore configuration updated
- `vaults/` — vault configs updated with new provider types

Detect VCS type:

- If `.jj/` directory exists → use the `jujutsu` skill
- Otherwise → use the `github-pr` skill (or direct `git` commands)

Offer to create the commit. Do not commit without asking.

**Verify:** Changes are committed (or the user chose to skip).

## State 5: joiner instructions

**Gate:** State 4 passed (or skipped).

**Action:** Generate copy-pasteable onboarding instructions tailored to the
actual configuration. See
[references/joiner-instructions.md](references/joiner-instructions.md) for the
template.

**Verify:** Instructions are shown to the user.

## References

- [reference.md](reference.md) — detailed walkthroughs with CLI output shapes
- [references/joiner-instructions.md](references/joiner-instructions.md) —
  joiner instruction template
- [references/troubleshooting.md](references/troubleshooting.md) — common
  failure modes and recovery
