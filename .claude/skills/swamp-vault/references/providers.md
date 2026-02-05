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
id: abc-123
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

## AWS Secrets Manager Provider

### Configuration Options

```yaml
# .swamp/vault/aws/{id}.yaml
id: def-456
name: prod-vault
type: aws
config:
  region: us-east-1 # Required
  profile: production # Optional: AWS profile name
  endpoint_url: http://localhost:4566 # Optional: LocalStack endpoint
  secret_prefix: myapp/ # Optional: Prefix for all secret names
createdAt: 2025-02-01T...
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

If AWS credentials are detected in the environment, swamp automatically
registers a default `aws` vault. This vault uses:

- Region from `AWS_REGION` or `AWS_DEFAULT_REGION` (defaults to `us-east-1`)
- Default credential chain for authentication

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
