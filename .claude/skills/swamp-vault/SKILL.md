---
name: swamp-vault
description: Manage swamp vaults for secure secret storage. Use when creating vaults, storing secrets, retrieving secrets, listing vault keys, or working with vault expressions in workflows. Triggers on "vault", "secret", "secrets", "credentials", "api key storage", "secure storage", "password", "token", "key management", "sensitive data", "encrypt", "aws secrets manager", "store secret", "put secret", "get secret", "credential storage", or vault-related CLI commands.
---

# Swamp Vault Skill

Manage secure secret storage through swamp vaults. All commands support `--json`
for machine-readable output.

## Quick Reference

| Task              | Command                                    |
| ----------------- | ------------------------------------------ |
| List vault types  | `swamp vault type search --json`           |
| Create a vault    | `swamp vault create <type> <name> --json`  |
| Search vaults     | `swamp vault search [query] --json`        |
| Get vault details | `swamp vault get <name_or_id> --json`      |
| Edit vault config | `swamp vault edit <name_or_id>`            |
| Store a secret    | `swamp vault put <vault> KEY=VALUE --json` |
| Get a secret      | `swamp vault get <vault> <key> --json`     |
| List secret keys  | `swamp vault list-keys <vault> --json`     |

## Repository Structure

Vaults use the dual-layer architecture:

- **Data directory (`/.swamp/vault/`)** - Internal storage by vault type
- **Logical views (`/vaults/`)** - Human-friendly symlinked directories

```
/vaults/{vault-name}/
  vault.yaml → ../.swamp/vault/{type}/{id}.yaml
  secrets/ → ../.swamp/secrets/{type}/{vault-name}/ (local_encryption only)
```

## Vault Types

Three vault types are available:

### aws-sm

Integrates with AWS Secrets Manager. Region is resolved at creation time from
`--region` flag or `AWS_REGION` env var.

```yaml
config:
  region: "us-east-1" # Resolved at creation time
```

### azure-kv

Integrates with Azure Key Vault. Vault URL is resolved at creation time from
`--vault-url` flag or `AZURE_KEYVAULT_URL` env var. Uses
`DefaultAzureCredential` for authentication (env vars, managed identity, Azure
CLI).

```yaml
config:
  vault_url: "https://myvault.vault.azure.net/" # Resolved at creation time
  # secret_prefix: "swamp/"  # Optional: prefix for all secret names
```

### local_encryption

Stores secrets encrypted locally using AES-GCM. Best for development and local
workflows.

```yaml
config:
  auto_generate: true # Generate encryption key automatically
  # OR
  ssh_key_path: "~/.ssh/id_rsa" # Use SSH key for encryption
```

## Create a Vault

```bash
swamp vault create local_encryption dev-secrets --json
swamp vault create aws-sm prod-secrets --region us-east-1 --json
swamp vault create azure-kv azure-secrets --vault-url https://myvault.vault.azure.net/ --json
```

**Output shape:**

```json
{
  "id": "abc-123",
  "name": "dev-secrets",
  "type": "local_encryption",
  "path": ".swamp/vault/local_encryption/abc-123.yaml"
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

## Get a Secret

Retrieve a specific secret value from a vault.

```bash
swamp vault get dev-secrets API_KEY --json
```

**Output shape:**

```json
{
  "vault": "dev-secrets",
  "key": "API_KEY",
  "value": "sk-1234567890"
}
```

**Note:** Use with caution. Secret values are sensitive and should not be logged
or displayed unnecessarily.

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

## Using Vaults in Workflows

For detailed workflow integration including the `swamp/lets-get-sensitive`
model, see the **swamp-workflow** skill.

**Quick syntax reference:**

```yaml
# In workflow step attributes
apiKey: ${{ vault.get(vault-name, secret-key) }}

# Environment-specific
prodToken: ${{ vault.get(prod-secrets, auth-token) }}
devToken: ${{ vault.get(dev-secrets, auth-token) }}
```

## Automatic Sensitive Field Storage

Model output schemas can mark fields as sensitive. When a method executes,
sensitive values are stored in a vault and replaced with vault references before
persistence — no manual `vault put` needed.

```typescript
// In an extension model's resource spec
resources: {
  "keypair": {
    schema: z.object({
      keyId: z.string(),
      keyMaterial: z.string().meta({ sensitive: true }),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
},
```

After execution, persisted data contains
`${{ vault.get('vault-name', 'auto-key') }}` instead of the plaintext secret.
The actual value is stored in the vault.

**Options:**

- `z.meta({ sensitive: true })` — mark individual fields
- `sensitiveOutput: true` on the spec — treat all fields as sensitive
- `vaultName` on the spec or field metadata — override which vault stores values
- `vaultKey` on field metadata — override the auto-generated vault key

A vault must be configured or an error is thrown at write time.

See the **swamp-extension-model** skill for full schema examples.

## Security Best Practices

1. **Environment separation**: Use different vaults for dev/staging/prod
2. **Never hardcode**: Always use vault expressions for secrets
3. **Audit access**: Monitor vault operations through logs
4. **Key rotation**: Rotate secrets and encryption keys regularly

## When to Use Other Skills

| Need                     | Use Skill        |
| ------------------------ | ---------------- |
| Vault usage in workflows | `swamp-workflow` |
| Create/run models        | `swamp-model`    |
| Repository structure     | `swamp-repo`     |
| Manage model data        | `swamp-data`     |

## References

- **Examples**: See [references/examples.md](references/examples.md) for
  multi-vault setups, workflow usage, and migration patterns
- **Provider details**: See [references/providers.md](references/providers.md)
  for encryption and configuration details
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  issues
