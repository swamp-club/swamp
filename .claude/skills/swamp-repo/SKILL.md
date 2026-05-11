---
name: swamp-repo
description: >
  Manage swamp repositories, datastores, extension sources, and the audit
  integration — initializing repos (single or multi-tool), upgrading swamp,
  syncing data, releasing stuck locks, loading extensions from external paths,
  and installing swamp in CI. Do NOT use for diagnosing health check failures
  or doctor command output (that is swamp-troubleshooting). Triggers on "repo",
  "repository", "init", "setup swamp", "upgrade swamp", ".swamp folder",
  "datastore", "datastore sync", "datastore lock", "stuck lock", "install
  swamp", "CI/CD", "extension source", ".swamp-sources.yaml", "source add",
  "source rm", "multi-tool repo", "multiple tools", "--tool", "enroll tool",
  "primary tool", "marker.tools".
---

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
├── extensions/              # Custom extensions
│   ├── models/              # TypeScript model definitions
│   ├── vaults/              # TypeScript vault implementations
│   ├── drivers/             # TypeScript driver implementations
│   └── datastores/          # TypeScript datastore implementations
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

### Multi-tool repos

`--tool` is repeatable to enroll multiple AI agent tools (Claude Code, Kiro,
Cursor, OpenCode, Codex, Copilot) in the same repo. Each tool's scaffolding
(skills directory, instructions file, settings/hooks) is written independently
since the paths don't overlap. The marker stores the full enrolled list as
`tools: [...]`.

```bash
# Enroll one tool (default: claude)
swamp repo init --json

# Enroll multiple tools at once
swamp repo init --tool claude --tool kiro --json

# Skip tool scaffolding
swamp repo init --tool none --json
```

The **primary tool** is the first entry in `marker.tools` — it's used by
commands that still operate on a single tool (audit recording, extension skills
directory resolution). Order is preserved; appending a tool keeps the existing
primary stable.

Duplicate `--tool` values are silently collapsed. `--tool none` cannot be
combined with other `--tool` values.

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
- `.gitignore` entries for `.swamp/` and `.swamp-sources.yaml`

### Verify the audit integration

Run `swamp doctor audit` after `init --tool <name>` and after upgrading the
external AI tool. Exits 1 on any check fail — safe to gate in CI. For the full
diagnostic flow (preflight checks, output shapes, common failures, escalation to
other tiers), see the `swamp-troubleshooting` skill's
`references/health-checks.md`.

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

`--tool` on `swamp repo upgrade` has **replace semantics** — the value(s) you
pass become the full enrolled tool list. Plain `swamp repo upgrade` with no
`--tool` flag preserves `marker.tools` and just bumps the version, re-syncing
scaffolding for every enrolled tool.

```bash
# Just bump the version, preserve the enrolled tools
swamp repo upgrade

# Add kiro to a [claude] repo (must list the full intended set)
swamp repo upgrade --tool claude --tool kiro

# Drop kiro from a [claude, kiro] repo
swamp repo upgrade --tool claude

# Clear all enrolled tools (drops scaffolding files stay on disk)
swamp repo upgrade --tool none
```

Dropping a tool from the list does **not** delete its on-disk files (`.kiro/`,
etc.) — remove them by hand if desired. Adding a tool that didn't share a skills
directory with the previous primary surfaces an `extensionsToReinstall` warning
naming pulled extensions that need to be re-installed for the new tool.

If the upgrade detects extensions tracked at a legacy on-disk layout
(`extensions/<type>/…` or `.swamp/pulled-extensions/<type>/…`), it re-pulls each
one into the current per-extension subtree
(`.swamp/pulled-extensions/<ext-name>/<type>/…`) and sweeps the old files
automatically — no follow-up `swamp extension install` command is required. This
step requires registry access; on failure, the legacy files are preserved and
the error names the affected extensions.

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

### Setting Up an Extension Datastore (e.g., S3)

Store runtime data in S3 for team collaboration using the `@swamp/s3-datastore`
extension:

```bash
swamp datastore setup extension @swamp/s3-datastore \
  --config '{"bucket":"my-bucket","prefix":"my-project","region":"us-east-1"}' --json
```

Verifies the backend is accessible, pushes existing local `.swamp/` data to the
remote, hydrates the local cache from any data already present in the remote (so
a contributor joining a populated shared bucket starts with their cache primed),
and updates `.swamp.yaml`. Subsequent commands automatically pull before
execution and push after.

`--skip-migration` skips only the local→remote push; the remote→local hydration
step still runs, so a fresh contributor can opt out of pushing their `.swamp/`
(or skip the migration entirely if they have no local data) without ending up
with an empty cache. Legacy type name `s3` is auto-remapped to
`@swamp/s3-datastore`.

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

The `filesPulled` and `filesPushed` counts in the output reflect work the sync
command itself performed — they do not double-count any implicit pre-command
sync from other commands, and they are not a no-op summary.

### Lock Management

Both filesystem and S3 datastores use a distributed lock to prevent concurrent
write access. Write commands (create, edit, delete, run, gc) acquire the lock
via `requireInitializedRepo()`. Read-only commands (search, get, list, validate,
history) use `requireInitializedRepoReadOnly()` which skips the lock, allowing
them to run concurrently with write operations. Locks auto-expire after 30
seconds if a process crashes.

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

### Custom Datastores

Install a community datastore or create your own in `extensions/datastores/`:

```bash
swamp extension search datastore --json    # Find community datastores
```

Configure in `.swamp.yaml` with `type:` and `config:` fields:

```yaml
datastore:
  type: "@myorg/my-store"
  config:
    endpoint: "https://storage.example.com"
    bucket: "my-data"
```

Or via environment variable (JSON config after the type):

```bash
export SWAMP_DATASTORE='@myorg/my-store:{"endpoint":"https://storage.example.com","bucket":"my-data"}'
```

For creating custom datastore implementations, see the `swamp-extension` skill.

### Custom Drivers

Custom execution drivers control where and how model methods run (SSH, Lambda,
Kubernetes, etc.). Drivers are configured per-definition, per-workflow, or
per-step via the `driver:` and `driverConfig:` YAML fields.

For creating custom driver implementations, see the `swamp-extension` skill.

### Environment Variable Override

For CI/CD, override the datastore without modifying `.swamp.yaml`:

```bash
export SWAMP_DATASTORE=s3:my-bucket/my-prefix
export SWAMP_DATASTORE=filesystem:/tmp/swamp-data
export SWAMP_DATASTORE='@myorg/my-store:{"key":"val"}'
```

## Extension Sources

Load extensions from external filesystem paths without copying files. Use this
when testing extensions from a separate development repo, using private
extensions that can't be published to swamp.club, or composing extensions from
multiple locations.

### `.swamp-sources.yaml`

A gitignored file at the repo root. Each entry is a **source** — a path (or
glob) pointing at a directory that contains extensions. Always added to
`.gitignore` by `swamp repo init` and `swamp repo upgrade`.

```yaml
sources:
  - path: ~/code/systeminit/swamp-extensions/model/aws/*
  - path: ~/code/acme-corp/internal-extensions/model/*
  - path: ~/code/my-experimental-vault
    only: [vaults]
```

**Fields:**

- `path` — filesystem path that contains extensions. Supports `~`, `$VAR`, and
  glob patterns (`*`, `**`). Two layouts are accepted:
  1. **Repo root**: a directory with `extensions/<kind>/` subdirectories. Most
     common — matches how published extensions are structured.
  2. **Direct content**: a directory whose files declare extension exports
     (`export const model = …`, `export const vault = …`, etc.) or workflow
     YAML. Useful when you want to point at a single-kind development tree or at
     an `extensions/<kind>/` directory directly. When both layouts exist in the
     same directory, the repo-root layout wins — the direct-content files at the
     root are ignored to prevent double-loading.
- `only` — optional filter limiting which extension types to load from this
  source: `models`, `vaults`, `drivers`, `datastores`, `reports`, `workflows`.

### Managing Sources

```bash
# Add a source (creates .swamp-sources.yaml if needed)
swamp extension source add ~/code/swamp-extensions/model/aws/ec2

# Add with glob (all AWS extensions)
swamp extension source add "~/code/swamp-extensions/model/aws/*"

# Add a directory that contains extension files directly (no extensions/ tree)
swamp extension source add ~/code/my-extensions/vault

# Add with type filter
swamp extension source add ~/code/my-vaults --only vaults

# List sources with status
swamp extension source list

# Remove a source
swamp extension source rm "~/code/swamp-extensions/model/aws/*"
```

`swamp extension source add` fails with a clear error if the path contributes no
extensions, so misconfigured paths are caught at add time rather than silently
ignored.

### Load Order

1. **Local extensions** (`extensions/models/`, etc.)
2. **Source extensions** (from `.swamp-sources.yaml`, in order listed)
3. **Pulled extensions** (`.swamp/pulled-extensions/`)

Load order is unchanged. Sources override pulled extensions of the same type.
This means you can pull `@swamp/aws/ec2` from the registry, then add a source
pointing at your local development copy — your local version loads instead.

## When to Use Other Skills

| Need                            | Use Skill               |
| ------------------------------- | ----------------------- |
| Create/run models               | `swamp-model`           |
| Create/run workflows            | `swamp-workflow`        |
| Manage secrets                  | `swamp-vault`           |
| Manage model data               | `swamp-data`            |
| Create custom TypeScript models | `swamp-extension`       |
| Create custom datastores        | `swamp-extension`       |
| Create custom drivers           | `swamp-extension`       |
| Understand swamp internals      | `swamp-troubleshooting` |

## References

- **CI/CD integration**: See
  [references/ci-integration.md](references/ci-integration.md) for installing
  swamp in CI, GitHub Actions examples, and version pinning
- **Structure**: See [references/structure.md](references/structure.md) for
  complete directory layout reference
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for config
  problems and recovery procedures
- **Repository design**: See [design/repo.md](design/repo.md)
- **Model structure**: See [design/models.md](design/models.md)
- **Datastore design**: See [design/datastores.md](design/datastores.md)
