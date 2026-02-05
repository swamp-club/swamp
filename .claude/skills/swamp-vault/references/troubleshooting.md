# Vault Troubleshooting

## Common Errors

### "Vault not found"

**Symptom**: `Error: Vault 'my-vault' not found`

**Causes and solutions**:

1. Vault doesn't exist - Create it:
   ```bash
   swamp vault create local_encryption my-vault
   ```

2. Typo in vault name - List available vaults:
   ```bash
   swamp vault search --json
   ```

3. Vault config file corrupted - Check the file:
   ```bash
   swamp vault get my-vault --json
   ```

### "Secret not found"

**Symptom**: `Error: Secret 'API_KEY' not found in vault 'dev-secrets'`

**Causes and solutions**:

1. Secret not stored yet:
   ```bash
   swamp vault put dev-secrets API_KEY=your-value
   ```

2. Wrong key name - List available keys:
   ```bash
   swamp vault list-keys dev-secrets --json
   ```

### AWS Authentication Errors

**Symptom**: `Error: Unable to load credentials`

**Solutions**:

1. Check environment variables:
   ```bash
   echo $AWS_ACCESS_KEY_ID
   echo $AWS_SECRET_ACCESS_KEY
   ```

2. Check AWS profile:
   ```bash
   aws sts get-caller-identity --profile your-profile
   ```

3. Verify region in vault config:
   ```bash
   swamp vault edit prod-vault
   ```

### Local Encryption Key Errors

**Symptom**: `Error: Cannot read encryption key`

**Causes and solutions**:

1. SSH key not found at specified path - Verify the path:
   ```bash
   ls -la ~/.ssh/id_rsa
   ```

2. Auto-generated key missing - The key should auto-regenerate, but check:
   ```bash
   ls -la .swamp/secrets/local_encryption/{vault-name}/.key
   ```

3. Key file permissions too open - Fix permissions:
   ```bash
   chmod 600 .swamp/secrets/local_encryption/{vault-name}/.key
   ```

### Expression Evaluation Errors

**Symptom**: `Error evaluating vault expression: vault.get(dev-secrets, KEY)`

**Causes**:

1. Vault doesn't exist
2. Secret key doesn't exist in vault
3. Vault provider authentication failed

**Debug steps**:

1. Verify vault exists:
   ```bash
   swamp vault get dev-secrets --json
   ```

2. Verify secret exists:
   ```bash
   swamp vault list-keys dev-secrets --json
   ```

3. Test retrieval manually (won't display value, but confirms access):
   ```bash
   # Use the swamp/lets-get-sensitive model to test
   swamp model create swamp/lets-get-sensitive test-get
   # Edit to set operation: get, vaultName, secretKey
   swamp model method run test-get get
   ```

## Vault Name Validation

Vault names must:

- Start with a lowercase letter
- Contain only lowercase letters, numbers, and hyphens
- Be unique across all vault types

**Invalid names**: `MyVault`, `123-vault`, `vault_name`, `VAULT` **Valid
names**: `dev-secrets`, `prod-vault`, `api-keys-v2`

## Rebuilding Logical Views

If vault symlinks are missing or broken:

```bash
swamp repo index
```

This rebuilds all logical views including `/vaults/{name}/` directories.
