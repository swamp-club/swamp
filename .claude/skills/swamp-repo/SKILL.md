---
name: swamp-repo
description: Manage swamp repositories. Use when initializing repos, upgrading swamp, rebuilding indexes, fixing symlinks, or starting the webapp. Triggers on "repo", "repository", "init", "initialize", "swamp init", "setup swamp", "new swamp project", "upgrade swamp", "rebuild index", "repo index", "fix symlinks", "broken symlinks", "webapp", "swamp webapp", "repository structure", "logical views", ".swamp folder".
---

# Swamp Repository Skill

Manage swamp repositories through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task                   | Command                     |
| ---------------------- | --------------------------- |
| Initialize repository  | `swamp repo init [path]`    |
| Upgrade repository     | `swamp repo upgrade [path]` |
| Rebuild symlink index  | `swamp repo index`          |
| Verify symlinks        | `swamp repo index --verify` |
| Remove broken symlinks | `swamp repo index --prune`  |
| Start web interface    | `swamp repo webapp [path]`  |

## Repository Structure

Swamp uses a dual-layer architecture:

```
my-swamp-repo/
├── .swamp/                  # Internal data storage
│   ├── definitions/         # Model definitions by type
│   ├── data/                # Model data by type
│   ├── outputs/             # Method execution outputs
│   ├── workflows/           # Workflow definitions
│   └── workflow-runs/       # Workflow execution records
├── models/                  # Logical view: models by name
├── workflows/               # Logical view: workflows by name
├── vaults/                  # Logical view: vaults by name
├── extensions/              # Custom model extensions
│   └── models/              # TypeScript model definitions
├── .swamp.yaml              # Repository metadata
└── CLAUDE.md                # Agent instructions
```

**Data Directory (`.swamp/`)**: Internal storage organized by entity type. This
is the source of truth for all swamp data.

**Logical Views**: Human-friendly symlinked directories that provide convenient
exploration paths into `.swamp/`. These are automatically maintained by domain
events when data changes.

## Initialize a Repository

Create a new swamp repository with all required directories and configuration.

```bash
swamp repo init --json
swamp repo init ./my-automation --json
```

**Output shape:**

```json
{
  "path": "/home/user/my-automation",
  "version": "0.1.0",
  "created": [".swamp/", "extensions/models/", ".swamp.yaml", "CLAUDE.md"]
}
```

**What gets created:**

- `.swamp/` directory structure for internal storage
- `extensions/models/` directory for custom model types
- `.swamp.yaml` configuration file with version metadata
- `CLAUDE.md` with agent instructions and skill references

## Upgrade a Repository

Update an existing repository to the latest swamp version. This updates skills,
configuration files, and migrates data if necessary.

```bash
swamp repo upgrade --json
swamp repo upgrade ./my-automation --json
```

**Output shape:**

```json
{
  "path": "/home/user/my-automation",
  "previousVersion": "0.0.9",
  "newVersion": "0.1.0",
  "updated": [".claude/skills/swamp-model/", "CLAUDE.md"]
}
```

Run `swamp repo upgrade` after updating the swamp binary to ensure your
repository has the latest skill files and configuration.

## Rebuild Repository Index

Rebuild, verify, or prune the logical view symlinks. Use this when symlinks
become out of sync or corrupted.

**Rebuild all symlinks:**

```bash
swamp repo index --json
```

**Output shape:**

```json
{
  "action": "rebuild",
  "models": { "created": 5, "updated": 2, "removed": 1 },
  "workflows": { "created": 3, "updated": 0, "removed": 0 },
  "vaults": { "created": 2, "updated": 0, "removed": 0 }
}
```

**Verify symlink integrity:**

```bash
swamp repo index --verify --json
```

**Output shape:**

```json
{
  "action": "verify",
  "valid": true,
  "broken": [],
  "missing": []
}
```

**Remove broken symlinks:**

```bash
swamp repo index --prune --json
```

**Output shape:**

```json
{
  "action": "prune",
  "removed": ["models/old-model", "workflows/deleted-workflow"]
}
```

## Start Web Interface

Launch a local web server for browsing and managing the repository.

```bash
swamp repo webapp --json
swamp repo webapp ./my-automation --json
```

**Output shape:**

```json
{
  "url": "http://localhost:8080",
  "path": "/home/user/my-automation"
}
```

## Logical View Details

### Models View (`/models/`)

```
/models/{model-name}/
  input.yaml → ../.swamp/definitions/{type}/{id}.yaml
  resource.yaml → ../.swamp/data/{type}/{id}/resource/latest/raw
  data.yaml → ../.swamp/data/{type}/{id}/data/latest/raw
  outputs/ → ../.swamp/outputs/{type}/{id}/
  logs/ → ../.swamp/data/{type}/{id}/ (filtered by type=log)
  files/ → ../.swamp/data/{type}/{id}/ (filtered by type=file)
```

### Workflows View (`/workflows/`)

```
/workflows/{workflow-name}/
  workflow.yaml → ../.swamp/workflows/{id}.yaml
  runs/
    latest → {most-recent-run}/
    {timestamp}/
      run.yaml → ../.swamp/workflow-runs/{id}/{run-id}.yaml
```

### Vaults View (`/vaults/`)

```
/vaults/{vault-name}/
  vault.yaml → ../.swamp/vault/{type}/{id}.yaml
  secrets/ → ../.swamp/secrets/{type}/{vault-name}/ (local_encryption only)
```

## When to Use Other Skills

| Need                            | Use Skill               |
| ------------------------------- | ----------------------- |
| Create/run models               | `swamp-model`           |
| Create/run workflows            | `swamp-workflow`        |
| Manage secrets                  | `swamp-vault`           |
| Manage model data               | `swamp-data`            |
| Create custom TypeScript models | `swamp-extension-model` |

## References

- **Structure**: See [references/structure.md](references/structure.md) for
  complete directory layout reference
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for symlink
  issues, index rebuild, and config problems
- **Repository design**: See [design/repo.md](design/repo.md)
- **Model structure**: See [design/models.md](design/models.md)
