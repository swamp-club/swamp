# Vault Troubleshooting

## Common Errors

### "Vault not found"

**Symptom**: `Error: Vault 'my-vault' not found`

**Causes and solutions**:

1. Vault doesn't exist - Create it:
   ```bash
   swamp vault create local_encryption my-vault --json
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
   swamp vault put dev-secrets API_KEY=your-value --json
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

### 1Password CLI Errors

**Symptom**: `Error: 1Password CLI (op) is not installed or not in PATH`

**Solution**: Install the `op` CLI from
https://developer.1password.com/docs/cli/get-started/ and authenticate:

```bash
# Service account
export OP_SERVICE_ACCOUNT_TOKEN=<token>

# Or enable desktop app CLI integration in 1Password settings
```

**Symptom**: `1Password authentication failed`

**Solution**: Sign in or set credentials:

```bash
op signin
# Or set OP_SERVICE_ACCOUNT_TOKEN
```

### User-Defined Vault Loading Errors

**Symptom**: `Warning: Failed to load user vault <file>: <error>`

**Causes and solutions**:

1. Missing `vault` export — ensure file has `export const vault = { ... }`
2. Invalid type format — must match `@collective/name` (e.g.,
   `@hashicorp/vault`)
3. Reserved collective — cannot use `@swamp/` or `@si/` collectives
4. Duplicate type — another file already registered the same type
5. Invalid `configSchema` — must be a Zod schema instance (`z.object({...})`)
6. Missing `createProvider` — must be a function returning a VaultProvider

**Symptom**: `Unknown vault type: @myorg/my-vault`

**Causes**:

1. Vault file not in `extensions/vaults/` (or configured vaults directory)
2. File has a `_test.ts` suffix (test files are excluded)
3. Bundle failed at startup — check for TypeScript errors in the vault file

**Debug steps**:

```bash
# Check if the type is registered
swamp vault type search --json

# Check startup logs for loading errors
SWAMP_DEBUG=1 swamp vault type search
```

### User-Defined Vault Config Errors

**Symptom**: `Invalid config for vault type '@myorg/my-vault': ...`

**Solution**: The `--config` JSON does not match the vault's `configSchema`.
Check the required fields:

```bash
# View available types and their descriptions
swamp vault type search --json
```

**Symptom**: `User-defined vault type requires --config <json>`

**Solution**: User-defined vaults always need `--config`:

```bash
swamp vault create @myorg/my-vault my-vault \
  --config '{"address": "https://example.com"}' --json
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
   swamp model create swamp/lets-get-sensitive test-get --json
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
