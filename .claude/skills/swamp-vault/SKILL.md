---
name: swamp-vault
description: Manage swamp vaults for secure secret storage. Use when creating vaults, storing secrets, retrieving secrets, listing vault keys, or working with vault expressions in workflows. Triggers on "vault", "secret", "secrets", "credentials", "api key storage", "secure storage", "password", "token", "key management", "sensitive data", "encrypt", "aws secrets manager", "store secret", "put secret", "get secret", "credential storage", "user-defined vault", "custom vault", "vault implementation", "extensions/vaults", "vault provider", or vault-related CLI commands.
---

# Swamp Vault Skill

Manage secure secret storage through swamp vaults.

## CRITICAL: Vault Creation Rules

- **Never generate vault IDs** — no `uuidgen`, `crypto.randomUUID()`, or manual
  UUIDs. Swamp assigns IDs automatically via `swamp vault create`.
- **Never write a vault YAML file from scratch** — always use
  `swamp vault create <type> <name>` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing vault file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help vault` for the complete, up-to-date CLI schema.

Correct flow: `swamp vault create <type> <name>` → edit config if needed
→ store secrets.

## Quick Reference

| Task              | Command                                            |
| ----------------- | -------------------------------------------------- |
| List vault types  | `swamp vault type search`                          |
| Create a vault    | `swamp vault create <type> <name>`                 |
| Search vaults     | `swamp vault search [query]`                       |
| Get vault details | `swamp vault get <name_or_id>`                     |
| Edit vault config | `swamp vault edit <name_or_id>`                    |
| Store a secret    | `swamp vault put <vault> KEY=VALUE`                |
| Store from stdin  | `echo "val" \| swamp vault put <vault> KEY`        |
| Store interactive | `swamp vault put <vault> KEY` (prompts for value)  |
| Get a secret      | `swamp vault get <vault> <key>`                    |
| List secret keys  | `swamp vault list-keys <vault>`                    |

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

### Built-in Types

| Type               | Description                   | Key Config                 |
| ------------------ | ----------------------------- | -------------------------- |
| `aws-sm`           | AWS Secrets Manager           | `--region` or `AWS_REGION` |
| `azure-kv`         | Azure Key Vault               | `--vault-url` or env var   |
| `1password`        | 1Password via CLI             | `--op-vault` or `OP_VAULT` |
| `local_encryption` | Local AES-GCM encrypted files | Auto-generated key         |

See [references/providers.md](references/providers.md) for full configuration
details on each built-in type.

### User-Defined Types

Create custom vault implementations in `extensions/vaults/*.ts`. User-defined
vaults follow the `@collective/name` type format (e.g., `@hashicorp/vault`,
`@openbao/vault`).

See [references/user-defined-vaults.md](references/user-defined-vaults.md) for
the full implementation guide, export contract, and examples.

Vault types from trusted collectives (e.g., `@swamp/aws-sm`) auto-resolve when
referenced in vault configurations — no manual `extension pull` needed. Use
`swamp extension trust list` to see which collectives are trusted.

## Create a Vault

```bash
# Built-in types
swamp vault create local_encryption dev-secrets
swamp vault create aws-sm prod-secrets --region us-east-1
swamp vault create azure-kv azure-secrets --vault-url https://myvault.vault.azure.net/
swamp vault create 1password op-secrets --op-vault "my-vault"

# User-defined types (pass config as JSON)
swamp vault create @hashicorp/vault my-hcv --config '{"address": "https://vault.example.com:8200"}'
```

After creation, edit the config if needed:

```bash
swamp vault edit dev-secrets
```

## Store Secrets

**Inline value (appears in shell history):**

```bash
swamp vault put dev-secrets API_KEY=sk-1234567890
swamp vault put prod-secrets DB_PASSWORD=secret123 -f  # Skip confirmation
```

**Piped value (recommended for scripts/CI — keeps secrets out of shell
history):**

```bash
echo "$API_KEY" | swamp vault put dev-secrets API_KEY
cat ~/secrets/token.txt | swamp vault put dev-secrets TOKEN
op read "op://vault/item/field" | swamp vault put dev-secrets SECRET
```

**Interactive prompt (recommended for humans — value is hidden):**

```bash
swamp vault put dev-secrets API_KEY
# Enter value for API_KEY: ********
```

When run interactively (TTY, no `=`, no piped stdin), the user is prompted to
enter the value with echo suppressed. This keeps secrets out of both shell
history and the visible terminal.

When no `=` is present and stdin is piped, the value is read from stdin. A
single trailing newline is stripped automatically.

**IMPORTANT — agent security:** Never ask the user to paste or type a secret
value into conversation. Instead, instruct them to run `vault put` directly in
their terminal using piped input. This prevents secrets from being logged in
agent context or chat history.

## Get a Secret

Retrieve a specific secret value from a vault.

```bash
swamp vault get dev-secrets API_KEY
```

**Note:** Use with caution. Secret values are sensitive and should not be logged
or displayed unnecessarily.

## List Secret Keys

Returns key names only (never values):

```bash
swamp vault list-keys dev-secrets
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

| Need                       | Use Skill               |
| -------------------------- | ----------------------- |
| Vault usage in workflows   | `swamp-workflow`        |
| Create/run models          | `swamp-model`           |
| Create custom model types  | `swamp-extension-model` |
| Repository structure       | `swamp-repo`            |
| Manage model data          | `swamp-data`            |
| Understand swamp internals | `swamp-troubleshooting` |

## References

- **User-defined vaults**: See
  [references/user-defined-vaults.md](references/user-defined-vaults.md) for
  creating custom vault implementations
- **Examples**: See [references/examples.md](references/examples.md) for
  multi-vault setups, workflow usage, and migration patterns
- **Provider details**: See [references/providers.md](references/providers.md)
  for encryption and configuration details
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  issues
