# Vault Provider Reference

## Local Encryption Provider

### Encryption Details

- **Algorithm**: AES-GCM (Advanced Encryption Standard, Galois/Counter Mode)
- **Key derivation**: PBKDF2 with SHA-256, 100,000 iterations
- **Salt**: 16 bytes, unique per secret
- **IV**: 96 bits, random per encryption

### Storage Layout

```
.swamp/secrets/{vault-type}/{vault-name}/
├── .key                    # Auto-generated encryption key (mode 0600)
└── {secret-key}.enc        # Encrypted secret files
```

### Configuration Options

```yaml
# vaults/local_encryption/{id}.yaml
id: 8f4e2d1c-9a3b-4c5d-ae7f-0a1b2c3d4e5f
name: dev-vault
type: local_encryption
config:
  # Option 1: Auto-generate key (recommended for development)
  auto_generate: true

  # Option 2: Use specific SSH key
  ssh_key_path: "~/.ssh/vault_key"

  # Option 3: Use default SSH key (~/.ssh/id_rsa)
  # (set auto_generate: false and omit ssh_key_path)

  # Optional: custom base directory for the secrets. Leave it out: an unset
  # base_dir is the repository root, resolved when the vault loads, so the
  # committed file works in every clone.
  # base_dir: /path/to/secrets-root
createdAt: 2025-02-01T...
```

`base_dir`, `key_file` and `ssh_key_path` expand a leading `~` or `$HOME` when
the vault is used, and the stored file keeps the unexpanded text. To keep
secrets beside a datastore outside the checkout, write
`base_dir: $HOME/.state/vault` rather than an absolute path, which only exists
on one machine. No other variable is expanded: `$OTHER/vault` is a folder named
`$OTHER`. A relative `base_dir` resolves against the repository root.

### Key Priority Order

1. SSH key at `ssh_key_path` if specified
2. Default SSH key at `~/.ssh/id_rsa` if `auto_generate: false`
3. Auto-generated key in `.key` file if `auto_generate: true`

On Unix, an SSH key readable beyond its owner (wider than `0600`) is refused. A
`.key` or `key_file` that wide is still used, with a warning to run `chmod 600`.

### Encrypted File Format

```json
{
  "iv": "base64-encoded-iv",
  "data": "base64-encoded-ciphertext",
  "salt": "base64-encoded-salt",
  "version": 1
}
```

## Extension Providers

AWS Secrets Manager, Azure Key Vault and 1Password are extension vault types
from the trusted `@swamp` collective; they install on first use. Each type's
README is the authoritative reference:

```bash
swamp extension info @swamp/aws-sm --json
```

Create them with `--config` JSON. The config is stored in plain text in
`vaults/<type>/{id}.yaml`, so it never holds credentials.

## AWS Secrets Manager (`@swamp/aws-sm`)

### Configuration

| Key       | Required | Description                                                       |
| --------- | -------- | ----------------------------------------------------------------- |
| `region`  | Yes      | AWS region holding the secrets, e.g. `us-east-1`                  |
| `profile` | No       | Named profile from `~/.aws/config`; overrides env-var credentials |

```bash
swamp vault create @swamp/aws-sm prod-vault \
  --config '{"region": "us-east-1"}' --json
```

### Authentication

Without `profile`, the default AWS credential chain:

1. Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
2. Shared credentials file: `~/.aws/credentials`
3. IAM role attached to the instance or task

### Secret Naming

Secret keys map directly to Secrets Manager secret names, including path-style
names such as `myapp/production/db-password`.

## Azure Key Vault (`@swamp/azure-kv`)

### Configuration

| Key             | Required | Description                                                   |
| --------------- | -------- | ------------------------------------------------------------- |
| `vault_url`     | Yes      | Full vault URL, e.g. `https://my-vault.vault.azure.net`       |
| `secret_prefix` | No       | Prefix for every secret name, to share one vault across repos |

```bash
swamp vault create @swamp/azure-kv azure-secrets \
  --config '{"vault_url": "https://my-vault.vault.azure.net"}' --json
```

### Authentication

Uses `DefaultAzureCredential`:

1. Environment variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_CLIENT_SECRET`
2. Azure CLI credentials (`az login`)
3. Managed Identity attached to the VM or container

### Secret Naming

Azure Key Vault secret names only allow alphanumeric characters and hyphens.
Forward slashes and underscores in swamp secret names are converted to hyphens
when stored.

- Without prefix: `{secret-key}` (with `/` and `_` replaced by `-`)
- With prefix: `{secret_prefix}{secret-key}` (same replacement applied)

## 1Password (`@swamp/1password`)

### Configuration

| Key                             | Required | Description                                              |
| ------------------------------- | -------- | -------------------------------------------------------- |
| `op_vault`                      | Yes      | 1Password vault name                                     |
| `op_account`                    | No       | Account shorthand or UUID, for multi-account setups      |
| `op_service_account_token_file` | No       | Absolute path to a file holding a service account token  |
| `read_retry_attempts`           | No       | Read attempts when a just-created item is not yet listed |
| `read_retry_seconds`            | No       | Window for those read retries                            |

```bash
swamp vault create @swamp/1password op-secrets \
  --config '{"op_vault": "my-vault", "op_account": "my-team"}' --json
```

### Authentication

Requires the 1Password CLI (`op`) in `PATH`, authenticated by one of:

1. Service account token: `OP_SERVICE_ACCOUNT_TOKEN`, or
   `op_service_account_token_file` in the config
2. Desktop app biometric unlock (enable CLI integration in 1Password settings)
3. 1Password Connect Server: `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN`

### Secret Key Mapping

Keys are mapped to 1Password `op://` URIs:

| Key Format              | Maps To                         |
| ----------------------- | ------------------------------- |
| `item-name`             | `op://vault/item-name/password` |
| `item-name/field`       | `op://vault/item-name/field`    |
| `item/section/field`    | `op://vault/item/section/field` |
| `op://vault/item/field` | Passed through directly         |

### Writes

- If the item exists, the field is updated via `op item edit`
- If the item does not exist, a new Secure Note is created via `op item create`
- Full `op://` URIs cannot be used for `put` operations

## Mock Provider (Testing Only)

A mock provider exists for testing and demonstrations. It stores secrets
in-memory and is pre-populated with demo secrets. This provider is intentionally
excluded from the public vault type list.

## Security Principles

All vault providers follow these security principles:

1. **Never log secrets**: Only metadata (key names, operation status) appears in
   logs
2. **Lazy evaluation**: Secrets retrieved only when expressions are evaluated
3. **No cross-run caching**: Secrets not persisted between workflow executions
4. **Error safety**: Exceptions don't expose secret values
5. **Vault isolation**: Each vault maintains independent authentication
