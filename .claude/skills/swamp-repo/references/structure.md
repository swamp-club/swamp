# Repository Structure Reference

## Overview

Swamp stores entities as flat files in top-level directories (`models/`,
`workflows/`, `vaults/`), with internal data (artifacts, outputs, runs) in
`.swamp/`.

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
├── models/                      # Model definitions by type
│   └── {normalized-type}/
│       └── {model-id}.yaml
│
├── workflows/                   # Workflow definitions (flat files)
│   └── workflow-{uuid}.yaml
│
├── vaults/                      # Vault configurations by type
│   └── {vault-type}/
│       └── {vault-id}.yaml
│
├── extensions/                  # Custom user extensions
│   ├── models/                  # TypeScript model definitions
│   │   ├── my_model.ts
│   │   └── aws/
│   │       └── s3_bucket.ts     # Nested organization supported
│   ├── vaults/                  # TypeScript vault implementations
│   ├── drivers/                 # TypeScript driver implementations
│   └── datastores/              # TypeScript datastore implementations
│
├── .claude/                     # Claude Code configuration
│   ├── skills/                  # Skill definitions
│   │   ├── swamp-model/
│   │   ├── swamp-workflow/
│   │   ├── swamp-vault/
│   │   ├── swamp-data/
│   │   ├── swamp-repo/
│   │   └── swamp-extension/
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
modelsDir: "extensions/models" # optional, default shown
workflowsDir: "extensions/workflows" # optional, default shown
vaultsDir: "extensions/vaults" # optional, default shown
driversDir: "extensions/drivers" # optional, default shown
datastoresDir: "extensions/datastores" # optional, default shown
trustedCollectives: # optional, default: ["swamp", "si"]
  - swamp
  - si
trustMemberCollectives: true # optional, default: true
```

`trustedCollectives` controls which extension collectives auto-resolve on first
use. The `swamp` and `si` collectives are trusted by default.

Additionally, collectives the user belongs to (cached during `auth login` /
`auth whoami`) are automatically trusted. Set `trustMemberCollectives: false` to
disable this and only trust the explicit list.

Manage trusted collectives via the CLI:

```bash
swamp extension trust list                # Show trusted collectives
swamp extension trust add <collective>    # Add a collective
swamp extension trust rm <collective>     # Remove a collective
swamp extension trust auto-trust <on|off> # Toggle membership auto-trust
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
id: e3f4a5b6-c7d8-4e9f-0a1b-2c3d4e5f6a7b
workflowId: f4a5b6c7-d8e9-4f0a-1b2c-3d4e5f6a7b8c
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
