---
name: swamp-vault
description: Manage swamp vaults for secure secret storage. Use when creating vaults, storing secrets, retrieving secrets, listing vault keys, or working with vault expressions in workflows. Triggers on "vault", "secret", "credentials", "api key storage", "secure storage", or vault-related CLI commands.
---

# Swamp Vault Skill

Manage secure secret storage through swamp vaults. All commands support `--json`
for machine-readable output.

## Repository Structure

Vaults use the dual-layer architecture:

- **Data directory (`/.data/vault/`)** - Internal storage by vault type
- **Logical views (`/vaults/`)** - Human-friendly symlinked directories

```
/vaults/{vault-name}/
  vault.yaml → ../.data/vault/{type}/{id}.yaml
  secrets/ → ../.data/secrets/{type}/{vault-name}/ (local_encryption only)
```

## Quick Reference

| Task              | Command                                    |
| ----------------- | ------------------------------------------ |
| List vault types  | `swamp vault type search --json`           |
| Create a vault    | `swamp vault create <type> <name> --json`  |
| Search vaults     | `swamp vault search [query] --json`        |
| Get vault details | `swamp vault get <name_or_id> --json`      |
| Edit vault config | `swamp vault edit <name_or_id>`            |
| Store a secret    | `swamp vault put <vault> KEY=VALUE --json` |
| List secret keys  | `swamp vault list-keys <vault> --json`     |

## Vault Types

Two vault types are available:

### local_encryption

Stores secrets encrypted locally using AES-GCM. Best for development and local
workflows.

```yaml
config:
  auto_generate: true # Generate encryption key automatically
  # OR
  ssh_key_path: "~/.ssh/id_rsa" # Use SSH key for encryption
```

### aws

Integrates with AWS Secrets Manager. Best for production environments.

```yaml
config:
  region: "us-east-1" # Required
  # profile: "default"  # Optional: AWS profile name
```

## Create a Vault

```bash
swamp vault create local_encryption dev-secrets --json
swamp vault create aws prod-secrets --json
```

**Output shape:**

```json
{
  "id": "abc-123",
  "name": "dev-secrets",
  "type": "local_encryption",
  "path": ".data/vault/local_encryption/abc-123.yaml"
}
```

After creation, edit the config if needed:

```bash
swamp vault edit dev-secrets
```

## Store Secrets

```bash
swamp vault put dev-secrets API_KEY=sk-1234567890 --json
swamp vault put prod-secrets DB_PASSWORD=secret123 -f --json  # Skip confirmation
```

**Output shape:**

```json
{
  "vault": "dev-secrets",
  "key": "API_KEY",
  "status": "stored"
}
```

## List Secret Keys

Returns key names only (never values):

```bash
swamp vault list-keys dev-secrets --json
```

**Output shape:**

```json
{
  "vault": "dev-secrets",
  "keys": ["API_KEY", "DB_PASSWORD"]
}
```

## Vault Expressions

Access secrets in model inputs and workflows using CEL expressions:

```yaml
attributes:
  apiKey: ${{ vault.get(dev-secrets, API_KEY) }}
  dbPassword: ${{ vault.get(prod-secrets, DB_PASSWORD) }}
```

**Key rules:**

- Vault must exist before expression evaluation
- Expressions are evaluated lazily at runtime
- Failed lookups throw errors with helpful messages

## Workflow Integration

Use the `swamp/lets-get-sensitive` model for vault operations in workflows:

```yaml
# Store a secret via workflow
- name: store-credentials
  task:
    type: model_method
    modelIdOrName: store-creds
    methodName: put

# Where store-creds model has:
# type: swamp/lets-get-sensitive
# attributes:
#   vaultName: prod-secrets
#   secretKey: api-token
#   secretValue: ${{ model.generator.data.attributes.token }}
#   operation: put
```

## Security Best Practices

1. **Environment separation**: Use different vaults for dev/staging/prod
2. **Never hardcode**: Always use vault expressions for secrets
3. **Audit access**: Monitor vault operations through logs
4. **Key rotation**: Rotate secrets and encryption keys regularly

## References

- **Provider details**: See [references/providers.md](references/providers.md)
  for encryption and configuration details
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  issues
