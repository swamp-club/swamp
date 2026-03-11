---
name: swamp-repo
description: Manage swamp repositories and datastores — initializing repos, upgrading swamp, syncing data, releasing stuck locks. Use when initializing repos, upgrading swamp, starting the webapp, or configuring datastores. Triggers on "repo", "repository", "init", "initialize", "swamp init", "setup swamp", "new swamp project", "upgrade swamp", "webapp", "swamp webapp", "repository structure", ".swamp folder", "datastore", "datastore setup", "datastore status", "datastore sync", "datastore lock", "s3 datastore", "filesystem datastore", "stuck lock", "lock release".
---

# Swamp Repository Skill

Manage swamp repositories through the CLI. All commands support `--json` for
machine-readable output.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help repo` for the complete, up-to-date CLI schema.

## Quick Reference

| Task                       | Command                                                 |
| -------------------------- | ------------------------------------------------------- |
| Initialize repository      | `swamp repo init [path] --json`                         |
| Upgrade repository         | `swamp repo upgrade [path] --json`                      |
| Start web interface        | `swamp repo webapp [path] --json`                       |
| Show datastore status      | `swamp datastore status --json`                         |
| Setup filesystem datastore | `swamp datastore setup filesystem --path <path> --json` |
| Setup S3 datastore         | `swamp datastore setup s3 --bucket <bucket> --json`     |
| Sync with S3               | `swamp datastore sync --json`                           |
| Check lock status          | `swamp datastore lock status --json`                    |
| Force-release stuck lock   | `swamp datastore lock release --force --json`           |

## Repository Structure

```
my-swamp-repo/
├── models/                  # Model definitions (YAML)
├── workflows/               # Workflow definitions (YAML)
├── vaults/                  # Vault configurations (YAML)
├── extensions/              # Custom model extensions
│   └── models/              # TypeScript model definitions
├── .swamp/                  # Runtime data (datastore)
│   ├── data/                # Versioned model data
│   ├── outputs/             # Method execution outputs
│   ├── workflow-runs/       # Workflow execution records
│   └── ...                  # Other runtime artifacts
├── .swamp.yaml              # Repository metadata
└── CLAUDE.md                # Agent instructions
```

**Top-level directories** (`models/`, `workflows/`, `vaults/`): Source-of-truth
YAML files. These are committed to git and reviewed in PRs.

**`.swamp/` directory**: Runtime data only. Can be gitignored entirely. When an
external datastore is configured, this data lives elsewhere (see Datastores
section below).

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

## Datastores

Runtime data (model data, workflow runs, outputs, audit logs) is stored in a
configurable **datastore**. By default, this is the local `.swamp/` directory.

### Checking Status

```bash
swamp datastore status --json
```

**Output shape:**

```json
{
  "type": "filesystem",
  "path": "/home/user/my-repo/.swamp",
  "healthy": true,
  "message": "OK",
  "latencyMs": 1,
  "directories": ["data", "outputs", "workflow-runs", "..."]
}
```

### Setting Up a Filesystem Datastore

Move runtime data to an external directory (e.g. shared NFS mount):

```bash
swamp datastore setup filesystem --path /mnt/shared/swamp-data --json
```

Migrates existing `.swamp/` runtime data to the new path and updates
`.swamp.yaml`. Use `--skip-migration` to skip the data copy.

### Setting Up an S3 Datastore

Store runtime data in S3 for team collaboration:

```bash
swamp datastore setup s3 --bucket my-bucket --prefix my-project --region us-east-1 --json
```

Pushes existing local data to S3 and updates `.swamp.yaml`. Subsequent commands
automatically pull before execution and push after. Use `--skip-migration` to
skip the initial push.

### Migrating Between Datastores

1. Check current status: `swamp datastore status --json`
2. Run setup with new backend: `swamp datastore setup <type> ... --json`
3. Verify health: `swamp datastore status --json` — confirm `healthy: true`
4. If unhealthy: check error message, fix credentials/paths, re-run setup

### Manual S3 Sync

```bash
swamp datastore sync --json         # Bidirectional sync
swamp datastore sync --pull --json  # Pull-only
swamp datastore sync --push --json  # Push-only
```

### Lock Management

Both filesystem and S3 datastores use a distributed lock to prevent concurrent
access. Locks auto-expire after 30 seconds if a process crashes.

```bash
swamp datastore lock status --json           # Show lock holder
swamp datastore lock release --force --json  # Force-release stuck lock
```

**Lock status output shape:**

```json
{
  "holder": "user@hostname",
  "hostname": "hostname",
  "pid": 12345,
  "acquiredAt": "2026-03-10T12:00:00.000Z",
  "ttlMs": 30000
}
```

Returns `null` if no lock is held.

### Environment Variable Override

For CI/CD, override the datastore without modifying `.swamp.yaml`:

```bash
export SWAMP_DATASTORE=s3:my-bucket/my-prefix
export SWAMP_DATASTORE=filesystem:/tmp/swamp-data
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
- **Datastore design**: See [design/datastores.md](design/datastores.md)
