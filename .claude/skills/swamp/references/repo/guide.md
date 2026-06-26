# Swamp Repository Skill

Manage swamp repositories through the CLI. All commands support `--json` for
machine-readable output.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help repo` for the complete, up-to-date CLI schema.

## Quick Reference

| Task                       | Command                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| Initialize repository      | `swamp repo init [path] --json`                                   |
| Upgrade repository         | `swamp repo upgrade [path] --json`                                |
| Start web interface        | `swamp repo webapp [path] --json`                                 |
| Show datastore status      | `swamp datastore status --json`                                   |
| Setup filesystem datastore | `swamp datastore setup filesystem --path <path> --json`           |
| Setup extension datastore  | `swamp datastore setup extension <type> --config '<json>' --json` |
| Sync remote datastore      | `swamp datastore sync --json`                                     |
| Check lock status          | `swamp datastore lock status --json`                              |
| Force-release stuck lock   | `swamp datastore lock release --force --json`                     |
| Add extension source       | `swamp extension source add <path> [--only models,vaults,...]`    |
| Remove extension source    | `swamp extension source rm <path>`                                |
| List extension sources     | `swamp extension source list --json`                              |

## Repository Structure

```
my-swamp-repo/
├── models/                  # Model definitions (YAML)
├── workflows/               # Workflow definitions (YAML)
├── vaults/                  # Vault configurations (YAML)
├── extensions/              # Custom extensions (TypeScript)
├── .swamp/                  # Runtime data (datastore, gitignored)
├── .swamp.yaml              # Repository metadata
└── CLAUDE.md                # Agent instructions
```

`swamp repo init` creates this structure. Top-level directories (`models/`,
`workflows/`, `vaults/`) hold source-of-truth YAML committed to git. `.swamp/`
holds runtime data and can be gitignored.

For detailed walkthroughs of each operation, see [reference.md](reference.md).
