# Repository Structure Reference

## Overview

Swamp uses a **dual-layer architecture**:

1. **Data Layer** (`.swamp/`) — Internal storage organized by entity type
2. **Logical Views** (`models/`, `workflows/`, `vaults/`) — Human-friendly
   symlinked directories

## Complete Directory Layout

```
my-swamp-repo/
├── .swamp/                      # Internal data storage (source of truth)
│   ├── definitions/             # Model definitions by normalized type
│   │   ├── command/
│   │   │   └── shell/
│   │   │       └── {model-id}.yaml
│   │   └── @user/
│   │       └── my-type/
│   │           └── {model-id}.yaml
│   │
│   ├── definitions-evaluated/   # Evaluated model definitions (expressions resolved)
│   │   └── (same structure as definitions/)
│   │
│   ├── data/                    # Model data by normalized type
│   │   └── {normalized-type}/
│   │       └── {model-id}/
│   │           └── {data-name}/
│   │               ├── 1/
│   │               │   ├── raw           # Actual data content
│   │               │   └── metadata.yaml # Version metadata
│   │               ├── 2/
│   │               │   ├── raw
│   │               │   └── metadata.yaml
│   │               └── latest → 2/       # Symlink to latest version
│   │
│   ├── outputs/                 # Method execution outputs
│   │   └── {normalized-type}/
│   │       └── {model-id}/
│   │           └── {output-id}.yaml
│   │
│   ├── workflows/               # Workflow definitions
│   │   └── {workflow-id}.yaml
│   │
│   ├── workflows-evaluated/     # Evaluated workflow definitions
│   │   └── {workflow-id}.yaml
│   │
│   ├── workflow-runs/           # Workflow execution records
│   │   └── {workflow-id}/
│   │       └── {run-id}.yaml
│   │
│   ├── vault/                   # Vault configurations
│   │   └── {vault-type}/
│   │       └── {vault-id}.yaml
│   │
│   ├── secrets/                 # Encrypted secrets (local_encryption only)
│   │   └── local_encryption/
│   │       └── {vault-name}/
│   │           ├── .key         # Encryption key (NEVER commit)
│   │           └── {secret-key} # Encrypted secret data
│   │
│   └── telemetry/               # Local telemetry data
│       └── events.jsonl
│
├── models/                      # Logical view: models by name
│   └── {model-name}/
│       ├── input.yaml → ../.swamp/definitions/{type}/{id}.yaml
│       ├── resource.yaml → ../.swamp/data/{type}/{id}/{spec}/latest/raw
│       ├── outputs/ → ../.swamp/outputs/{type}/{id}/
│       └── files/ → ../.swamp/data/{type}/{id}/ (filtered)
│
├── workflows/                   # Logical view: workflows by name
│   └── {workflow-name}/
│       ├── workflow.yaml → ../.swamp/workflows/{id}.yaml
│       └── runs/
│           ├── latest → {most-recent-run}/
│           └── {timestamp}/
│               └── run.yaml → ../.swamp/workflow-runs/{id}/{run-id}.yaml
│
├── vaults/                      # Logical view: vaults by name
│   └── {vault-name}/
│       ├── vault.yaml → ../.swamp/vault/{type}/{id}.yaml
│       └── secrets/ → ../.swamp/secrets/{type}/{vault-name}/ (local only)
│
├── extensions/                  # Custom user extensions
│   └── models/                  # TypeScript model definitions
│       ├── my_model.ts
│       └── aws/
│           └── s3_bucket.ts     # Nested organization supported
│
├── .claude/                     # Claude Code configuration
│   ├── skills/                  # Skill definitions
│   │   ├── swamp-model/
│   │   ├── swamp-workflow/
│   │   ├── swamp-vault/
│   │   ├── swamp-data/
│   │   ├── swamp-repo/
│   │   └── swamp-extension-model/
│   └── settings.local.json      # Claude permissions
│
├── .swamp.yaml                  # Repository metadata
├── .gitignore                   # Git ignore (auto-generated)
└── CLAUDE.md                    # Agent instructions
```

## Key Files

### .swamp.yaml

Repository marker and metadata:

```yaml
swampVersion: "0.1.0"
initializedAt: "2025-01-15T10:30:00Z"
upgradedAt: "2025-01-20T14:00:00Z"
```

### CLAUDE.md

Agent instructions generated on init. Contains:

- Skills list
- Getting started guide
- Command reference

### settings.local.json

Claude Code permissions for swamp commands:

```json
{
  "permissions": {
    "allow": [
      "Bash(swamp model:*)",
      "Bash(swamp workflow:*)",
      "Bash(swamp vault:*)",
      "Bash(swamp data:*)",
      "Bash(swamp repo:*)"
    ]
  }
}
```

## Data Directory Details

### Model Definitions (.swamp/definitions/)

YAML files containing model input configuration:

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-shell
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: "echo 'Hello'"
```

**Path pattern**: `.swamp/definitions/{normalized-type}/{model-id}.yaml`

- `normalized-type`: e.g., `command/shell`, `@user/my-type`
- `model-id`: UUID assigned at creation

### Model Data (.swamp/data/)

Versioned data artifacts produced by model methods:

```
.swamp/data/command/shell/{model-id}/result/
  1/
    raw           # JSON: {"stdout":"Hello","exitCode":0}
    metadata.yaml # {"version":1,"createdAt":"...","tags":{"type":"resource"}}
  2/
    raw
    metadata.yaml
  latest → 2/
```

### Workflow Runs (.swamp/workflow-runs/)

Execution records for each workflow run:

```yaml
id: run-123
workflowId: wf-456
status: succeeded
startedAt: "2025-01-15T10:30:00Z"
completedAt: "2025-01-15T10:30:05Z"
jobs:
  - name: main
    status: succeeded
    steps:
      - name: step-1
        status: succeeded
        duration: 2000
```

## Logical View Symlinks

### models/{name}/

| Symlink         | Target                                             |
| --------------- | -------------------------------------------------- |
| `input.yaml`    | `.swamp/definitions/{type}/{id}.yaml`              |
| `resource.yaml` | `.swamp/data/{type}/{id}/{spec}/latest/raw`        |
| `outputs/`      | `.swamp/outputs/{type}/{id}/`                      |
| `files/`        | `.swamp/data/{type}/{id}/` (filtered by type=file) |

### workflows/{name}/

| Symlink              | Target                                    |
| -------------------- | ----------------------------------------- |
| `workflow.yaml`      | `.swamp/workflows/{id}.yaml`              |
| `runs/latest`        | `runs/{most-recent-timestamp}/`           |
| `runs/{ts}/run.yaml` | `.swamp/workflow-runs/{id}/{run-id}.yaml` |

### vaults/{name}/

| Symlink      | Target                                             |
| ------------ | -------------------------------------------------- |
| `vault.yaml` | `.swamp/vault/{type}/{id}.yaml`                    |
| `secrets/`   | `.swamp/secrets/{type}/{vault-name}/` (local only) |

## File Ownership and Permissions

### Files to Never Commit

These files contain sensitive data and are included in `.gitignore`:

| Path                     | Reason                          |
| ------------------------ | ------------------------------- |
| `.swamp/secrets/keyfile` | Encryption key for local vaults |
| `.swamp/secrets/**`      | Encrypted secret data           |
| `.swamp/telemetry/`      | Local telemetry events          |
| `.claude/`               | Claude Code local config        |

### Recommended .gitignore

Auto-generated on `swamp repo init`:

```gitignore
# Swamp managed defaults
.swamp/telemetry/
.swamp/secrets/keyfile
.claude/
```

## Rebuilding the Index

When symlinks become stale or broken:

```bash
# Verify current state
swamp repo index --verify --json

# Remove broken symlinks
swamp repo index --prune --json

# Full rebuild
swamp repo index --json
```
