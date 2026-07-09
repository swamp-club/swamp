# Share — Detailed Reference

Walkthroughs for each state machine step with exact commands and output shapes.
For the state machine overview, see [guide.md](guide.md).

## Assess: Reading Repo State

### Datastore status

```bash
swamp datastore status --json
```

Output shape:

```json
{
  "type": "filesystem",
  "path": "/path/to/.swamp",
  "healthy": true,
  "message": "OK",
  "latencyMs": 1,
  "directories": ["data", "outputs", "workflow-runs", ...]
}
```

Key fields:

- `type` — `"filesystem"` means local (not shareable). Any other value (e.g.
  `"@swamp/s3-datastore"`) means external (shareable).
- `healthy` — `true` if the datastore is reachable.
- `path` — only present for filesystem datastores.

### Vault listing

```bash
swamp vault search --json
```

Returns an array of vault configs. Each has `name`, `type`, and `config`. Look
for `type: "local_encryption"` — these vaults need migration for team sharing
because their encryption keys are stored locally in `.swamp/secrets/` and won't
be available on other machines.

### Git remote

```bash
git remote -v
```

If no remote is configured, warn the user — teammates need a way to clone the
repo. This is informational only; the share flow does not configure git.

### Doctor diagnostics

```bash
swamp doctor datastores --json
```

Output shape:

```json
{
  "overallStatus": "pass",
  "datastoreType": "@swamp/s3-datastore",
  "isCustom": true,
  "healthFindings": [
    { "check": "health", "passed": true, "message": "OK" }
  ],
  "vaultMismatchFindings": [
    { "vaultName": "secrets", "vaultType": "local_encryption" }
  ]
}
```

The `vaultMismatchFindings` array lists vaults that need migration. If empty,
vaults are compatible with the shared datastore.

## Datastore Setup

For datastore operations in depth, cross-link to the repo guide:
[../repo/reference.md](../repo/reference.md) (Datastores section).

### Interactive setup

```bash
swamp datastore setup
```

When run without a subcommand, launches an interactive wizard that:

1. Shows current datastore config
2. Asks where to store data (S3, filesystem path, other extension)
3. Prompts for provider-specific config (bucket, region, path, etc.)
4. Runs the migration and verifies health

### S3 setup (explicit)

```bash
swamp datastore setup extension @swamp/s3-datastore \
  --config '{"bucket":"my-bucket","prefix":"project","region":"us-east-1"}' \
  --json
```

The migration copies local `.swamp/` data to the S3 cache, pushes to remote,
then hydrates the cache back from remote to verify round-trip.

### Filesystem setup (explicit)

```bash
swamp datastore setup filesystem --path /shared/storage/project --json
```

Moves data to a shared filesystem path. Simpler than S3 but requires all
teammates to have access to the same path.

### Verify after setup

```bash
swamp datastore status --json
```

Confirm `type` changed and `healthy: true`.

## Vault Migration

For vault operations in depth, cross-link to the vault guide:
[../vault/reference.md](../vault/reference.md).

### Interactive migration

```bash
swamp vault migrate <vault-name>
```

When run without `--to-type`, launches an interactive flow that:

1. Shows current vault info
2. Lists available vault providers
3. Prompts for provider selection and config
4. Previews the migration (secret count, source → target)
5. Asks for confirmation
6. Copies secrets and updates config

### Explicit migration

```bash
swamp vault migrate <vault-name> \
  --to-type @swamp/aws-sm \
  --config '{"region":"us-east-1"}' \
  --json
```

### Available vault providers

| Provider            | Type               | Notes                                 |
| ------------------- | ------------------ | ------------------------------------- |
| AWS Secrets Manager | `@swamp/aws-sm`    | Needs AWS credentials                 |
| Azure Key Vault     | `@swamp/azure-kv`  | Needs Azure credentials               |
| 1Password           | `@swamp/1password` | Needs 1Password CLI + service account |

### Batch migration

If the user wants the same provider for all vaults, run each sequentially:

```bash
swamp vault migrate vault-1 --to-type @swamp/aws-sm --config '...' --force
swamp vault migrate vault-2 --to-type @swamp/aws-sm --config '...' --force
```

Use `--force` to skip the confirmation prompt when batching.

### Verify after migration

```bash
swamp vault search --json
```

Confirm each migrated vault shows the new type.

## Namespaces (Optional)

For multi-repo shared datastores, a namespace prevents data collisions. This is
optional for simple two-person sharing but required when multiple repos share
one S3 bucket.

```bash
swamp datastore namespace set <slug> --json
swamp datastore namespace migrate --confirm --json
```

See [../repo/references/namespaces.md](../repo/references/namespaces.md) for
full namespace documentation.

## Commit Step — VCS Detection

Detect which VCS the repo uses:

```bash
test -d .jj && echo "jujutsu" || echo "git"
```

- **jujutsu**: Use the `jujutsu` skill to create a change and describe it.
- **git**: Use the `github-pr` skill or standard `git add` / `git commit`.

Files that changed:

- `.swamp.yaml` — datastore config updated
- `vaults/<type>/<id>.yaml` — vault configs with new provider types
- `.swamp/secrets/` — may have been cleaned up after vault migration

Suggested commit message:
`feat(repo): promote to shared datastore with remote vault storage`

## Joiner Instructions

See [references/joiner-instructions.md](references/joiner-instructions.md) for
the template used to generate copy-pasteable onboarding instructions.
