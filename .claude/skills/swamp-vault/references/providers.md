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
# .swamp/vault/local_encryption/{id}.yaml
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

  # Optional: Custom base directory
  base_dir: /path/to/repo
createdAt: 2025-02-01T...
```

### Key Priority Order

1. SSH key at `ssh_key_path` if specified
2. Default SSH key at `~/.ssh/id_rsa` if `auto_generate: false`
3. Auto-generated key in `.key` file if `auto_generate: true`

### Encrypted File Format

```json
{
  "iv": "base64-encoded-iv",
  "data": "base64-encoded-ciphertext",
  "salt": "base64-encoded-salt",
  "version": 1
}
```

## AWS Secrets Manager Provider (`aws-sm`)

### Configuration Options

```yaml
# .swamp/vault/aws-sm/{id}.yaml
id: 2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e
name: prod-vault
type: aws-sm
config:
  region: us-east-1 # Resolved at creation time from --region or AWS_REGION
createdAt: 2025-02-01T...
```

### Creation

```bash
# Explicit region
swamp vault create aws-sm prod-vault --region us-east-1 --json

# From environment variable (logs a message confirming env var usage)
export AWS_REGION=us-east-1
swamp vault create aws-sm prod-vault --json
```

### Authentication

AWS credentials are obtained from the default credential chain:

1. Environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
2. Shared credentials file: `~/.aws/credentials`
3. IAM roles (EC2, ECS, Lambda)
4. Web identity tokens (EKS)

### Secret Naming

Secrets in AWS Secrets Manager are named:

- Without prefix: `{secret-key}`
- With prefix: `{secret_prefix}{secret-key}`

### Auto-Registration

If AWS credentials and region are detected in the environment
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`), swamp
automatically registers a default `aws-sm` vault.

## Azure Key Vault Provider (`azure-kv`)

### Configuration Options

```yaml
# .swamp/vault/azure-kv/{id}.yaml
id: 4d5e6f7a-8b9c-4d0e-1f2a-3b4c5d6e7f8a
name: azure-secrets
type: azure-kv
config:
  vault_url: https://myvault.vault.azure.net/ # Resolved at creation time
  secret_prefix: swamp/ # Optional: prefix for all secret names
createdAt: 2025-02-01T...
```

### Creation

```bash
# Explicit vault URL
swamp vault create azure-kv azure-secrets --vault-url https://myvault.vault.azure.net/ --json

# From environment variable (logs a message confirming env var usage)
export AZURE_KEYVAULT_URL=https://myvault.vault.azure.net/
swamp vault create azure-kv azure-secrets --json
```

### Authentication

Uses `DefaultAzureCredential` from the Azure SDK, which tries (in order):

1. Environment variables: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
   `AZURE_CLIENT_SECRET`
2. Workload Identity (Azure-hosted workloads)
3. Managed Identity (Azure VMs, App Service, etc.)
4. Azure CLI credentials (`az login`)
5. Azure PowerShell credentials
6. Azure Developer CLI credentials

### Secret Naming

Azure Key Vault secret names only allow alphanumeric characters and hyphens.
Forward slashes and underscores in swamp secret names are automatically
converted to hyphens when stored.

- Without prefix: `{secret-key}` (with `/` and `_` replaced by `-`)
- With prefix: `{secret_prefix}{secret-key}` (same replacement applied)

## 1Password Provider (`1password`)

### Configuration Options

```yaml
# .swamp/vault/1password/{id}.yaml
id: 6f7a8b9c-0d1e-4f2a-3b4c-5d6e7f8a9b0c
name: op-secrets
type: 1password
config:
  op_vault: my-vault # 1Password vault name (required)
  op_account: my-team # Account shorthand for multi-account setups (optional)
createdAt: 2025-02-01T...
```

### Creation

```bash
# Explicit vault name
swamp vault create 1password op-secrets --op-vault "my-vault" --json

# With account shorthand
swamp vault create 1password op-secrets --op-vault "my-vault" --op-account "my-team" --json

# From environment variables
export OP_VAULT=my-vault
export OP_ACCOUNT=my-team
swamp vault create 1password op-secrets --json
```

### Authentication

Requires the 1Password CLI (`op`). Authenticates via (in order):

1. Service account token: `OP_SERVICE_ACCOUNT_TOKEN`
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

### Write Behavior

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
