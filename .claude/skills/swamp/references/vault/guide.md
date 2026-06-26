# Swamp Vault Skill

Manage secure secret storage through swamp vaults. All commands support `--json`
for machine-readable output.

## CRITICAL: Vault Creation Rules

- **Never generate vault IDs** — no `uuidgen`, `crypto.randomUUID()`, or manual
  UUIDs. Swamp assigns IDs automatically via `swamp vault create`.
- **Never write a vault YAML file from scratch** — always use
  `swamp vault create <type> <name> --json` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing vault file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help vault` for the complete, up-to-date CLI schema.

Correct flow: `swamp vault create <type> <name> --json` → edit config if needed
→ store secrets.

## Quick Reference

| Task              | Command                                                 |
| ----------------- | ------------------------------------------------------- |
| List vault types  | `swamp vault type search --json`                        |
| Create a vault    | `swamp vault create <type> <name> --json`               |
| Search vaults     | `swamp vault search [query] --json`                     |
| Get vault details | `swamp vault get <name_or_id> --json`                   |
| Edit vault config | `swamp vault edit <name_or_id>`                         |
| Store a secret    | `swamp vault put <vault> KEY` (prompts for value)       |
| Store from stdin  | `echo "$VAL" \| swamp vault put <vault> KEY --json`     |
| Store inline      | `swamp vault put <vault> KEY=VALUE --json` (insecure)   |
| Read a secret     | `swamp vault read-secret <vault> <key> --force --json`  |
| List secret keys  | `swamp vault list-keys <vault> --json`                  |
| Annotate a secret | `swamp vault annotate <vault> <key> --url <u>`          |
| Remove a label    | `swamp vault annotate <vault> <key> --remove-label <k>` |
| Inspect metadata  | `swamp vault inspect <vault> <key> --json`              |
| Clear annotation  | `swamp vault annotate <vault> <key> --clear`            |
| Migrate backend   | `swamp vault migrate <vault> --to-type <type>`          |

For detailed walkthroughs of each operation, see [reference.md](reference.md).
