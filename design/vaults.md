# swamp vaults

A swamp vault is a secure storage system that allows workflows and models to
access sensitive data through named vault configurations. Vaults provide a clean
abstraction layer over different secret management systems, enabling secure data
retrieval and storage during workflow execution.

## Architecture

The vault system is built around a named vault architecture where:

- **Named Vaults**: Each vault instance has a user-defined name configured in
  `/.swamp/vault/{vault type}/{id}.yaml`
- **Vault Types**: The underlying storage system (AWS Secrets Manager, HashiCorp
  Vault, etc.) is specified per vault
- **Clean Interface**: All vaults implement a common interface for consistent
  access patterns
- **Expression Integration**: Vaults are accessed through CEL expressions using
  `${{ vault.get(vault_name, key) }}` syntax

## Logical Views

The RepoIndexService maintains a vault-centric logical view at `/vaults/` that
provides human/agent-friendly exploration of vaults by name.

### Vault View Structure

```
/vaults/{vault-name}/
  vault.yaml   → symlink to /.swamp/vault/{vault-type}/{id}.yaml
  secrets/     → symlink to /.swamp/secrets/{vault-type}/{vault-name}/ (local vaults only)
```

Since vault names are unique across all types, the logical view uses a flat
structure that allows exploring vault definitions using human-readable names
without needing to know the vault type.

For vault types that store secrets locally (e.g., `local_encryption`), a
`secrets/` symlink is included to provide access to the encrypted secret files.
Remote vault types (e.g., `aws`) do not have a local secrets directory.

## Secret Storage

Vault secrets are stored in `.swamp/secrets/` organized by vault type and name:

```
.swamp/
├── vault/
│   └── {vault-type}/
│       └── {id}.yaml              # Vault configuration
└── secrets/
    └── {vault-type}/
        └── {vault-name}/
            ├── .key               # Encryption key (for local_encryption with auto_generate)
            └── {secret-key}.enc   # Encrypted secret files
```

The secrets path is computed at runtime from `base_dir` + vault type + vault
name. The vault configuration stores the `base_dir` (repository root), and the
full path is derived as `{base_dir}/.swamp/secrets/{vault-type}/{vault-name}/`.

## Vault Provider Interface

All vault implementations must implement the `VaultProvider` interface:

```typescript
interface VaultProvider {
  // Retrieve a secret value by key
  get(secretKey: string): Promise<string>;

  // Store a secret value with the given key
  put(secretKey: string, secretValue: string): Promise<void>;

  // List all secret keys in the vault (returns key names only, not values)
  list(): Promise<string[]>;

  // Get the name/type of this vault provider
  getName(): string;
}
```

## Expression Syntax

Vaults are accessed in CEL expressions using the `vault.get()` and `vault.put()`
functions:

```yaml
# Basic vault access
keyData: ${{ vault.get(aws, machineKeyData) }}

# Different vault for different environments
prodSecret: ${{ vault.get(prod-vault, apiKey) }}
devSecret: ${{ vault.get(dev-vault, apiKey) }}

# Store sensitive output to vault
apiKeyStorage: ${{ vault.put(aws, generated-api-key, self.data.attributes.apiKey) }}
```

The expression syntax is:

- `vault.get(vault_name, key)` - Retrieve a secret from the named vault
- `vault.put(vault_name, key, value)` - Store a secret value in the named vault
- `vault_name` - References a configured vault
- `key` - The secret identifier within that vault
- `value` - The value to store (for put operations)

## Sensitive Field Marking (Implemented)

Model schemas mark fields as sensitive using Zod's `.meta()` method. When a
method executes, sensitive output fields are automatically stored in a vault and
replaced with vault reference expressions before persistence.

### Schema Metadata

Mark individual fields as sensitive in a resource output spec schema:

```typescript
resources: {
  result: {
    schema: z.object({
      keyId: z.string(),
      keyMaterial: z.string().meta({ sensitive: true }),
      publicKey: z.string(),
    }),
    lifetime: "infinite",
    garbageCollection: 10,
  },
},
```

Supported metadata properties on `.meta()`:

- `sensitive: boolean` - Marks the field as containing sensitive data (required)
- `vaultKey?: string` - Custom vault key (defaults to auto-generated path)
- `vaultName?: string` - Specific vault to use (overrides spec/default vault)

### Spec-Level `sensitiveOutput`

When an entire resource output is sensitive, set `sensitiveOutput: true` on the
`ResourceOutputSpec` instead of marking each field individually:

```typescript
resources: {
  result: {
    schema: z.object({ ... }),
    lifetime: "infinite",
    garbageCollection: 10,
    sensitiveOutput: true,  // All fields treated as sensitive
    vaultName: "my-vault",  // Optional: override vault for this spec
  },
},
```

### Vault Key Naming

Auto-generated vault keys are built from the model type, ID, method name, and
field path, then sanitized to replace characters that are invalid in vault secret
keys (`@` is removed, `/` and `\` are replaced with `-`):

```
{sanitized modelType}-{modelId}-{methodName}-{fieldPath}
```

For example: `@user/aws/ec2-keypair` with field `KeyMaterial` becomes
`user-aws-ec2-keypair-abc-123-createKeyPair-KeyMaterial`

Custom keys can be specified via `vaultKey` in field metadata:

```typescript
apiKey: z.string().meta({ sensitive: true, vaultKey: "my-api-key" }),
```

### Vault Reference Format

Sensitive values are replaced with CEL-compatible vault reference expressions
using single-quoted string arguments:

```
${{ vault.get('vault-name', 'vault-key') }}
```

### Vault Resolution Order

The vault used for storing a sensitive field is resolved in this order:

1. Field-level `vaultName` from `.meta()` metadata
2. Spec-level `vaultName` from `ResourceOutputSpec`
3. First available vault from `VaultService`

### Processing Behavior

- Values are **snapshotted** before processing to prevent cross-contamination
  when multiple fields are sensitive
- Non-string values are JSON-stringified before vault storage
- Fields with `null` or `undefined` values are skipped
- If sensitive fields exist but no vault is configured, an error is thrown with
  guidance to create a vault
- Processing is injected inside `createResourceWriter()` before JSON
  serialization, so it applies transparently to all resource writes

### Implementation

Processing is handled by `processSensitiveResourceData()` in
`src/domain/models/data_writer.ts`. Schema introspection is performed by
`extractSensitiveFields()` in `src/domain/models/sensitive_field_extractor.ts`.

### Input Fields

Input fields use vault expressions directly in YAML:

```yaml
keyData: ${{ vault.get('aws', 'machineKeyData') }}
```

The expression evaluation system resolves these at runtime.

## AWS Secrets Manager Provider

The AWS Secrets Manager provider is the initial implementation supporting:

### Authentication

- **IAM Roles**: Preferred method using instance/task roles
- **Environment Variables**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- **AWS Profiles**: Named profiles from `~/.aws/credentials`
- **Default Credential Chain**: Standard AWS SDK credential resolution

### Configuration Options

```yaml
vaults:
  aws:
    type: "aws"
    region: "us-east-1" # Required: AWS region
    profile: "production" # Optional: AWS profile name
    endpoint_url: "https://custom.com" # Optional: Custom endpoint
    secret_prefix: "myapp/" # Optional: Prefix for all secret names
```

### Secret Organization

- Secrets are stored with optional prefixes for organization
- Key names in expressions map to secret names in AWS Secrets Manager
- Support for both string secrets and JSON secrets with key extraction

### Error Handling

- **Missing Secrets**: Throws descriptive error with vault and key information
- **Authentication Failures**: Clear error messages for credential issues
- **Network Errors**: Retry logic with exponential backoff
- **Invalid Configuration**: Validation during vault initialization

## Vault Model

A dedicated `swamp/lets-get-sensitive` model provides direct vault operations in
workflows:

### Input Attributes

- `vaultName: string` - Name of the vault to use
- `secretKey: string` - Key identifier for the secret
- `secretValue?: string` - Value to store (for put operations, marked as
  sensitive)
- `operation: "get" | "put"` - Operation to perform

### Methods

- **get**: Retrieve a secret value from the specified vault
- **put**: Store a secret value in the specified vault

### Usage Examples

**Retrieve Secret:**

```yaml
id: vault-get-example
type: swamp/lets-get-sensitive
name: get-api-key
version: 1
attributes:
  vaultName: aws
  secretKey: production-api-key
  operation: get
```

**Store Secret:**

```yaml
id: vault-put-example
type: swamp/lets-get-sensitive
name: store-generated-token
version: 1
attributes:
  vaultName: aws
  secretKey: new-auth-token
  secretValue: ${{ data.latest('api-generator', 'result').attributes.token }}
  operation: put
```

### Output Data

- `success: boolean` - Whether the operation succeeded
- `retrievedValue?: string` - Retrieved secret value (for get operations, marked
  as sensitive)
- `storedKey?: string` - Key where value was stored (for put operations)
- `error?: string` - Error message if operation failed
- `timestamp: string` - Operation timestamp

## Workflow Integration

Vaults integrate seamlessly with the expression evaluation system:

### Dependency Resolution

When a vault expression is encountered:

1. The vault name is resolved from repository configuration
2. The appropriate vault provider is instantiated
3. The secret is retrieved during expression evaluation
4. The value is injected into the final data structure

### Lazy Evaluation

Vault access is lazy - secrets are only retrieved when expressions are
evaluated, ensuring:

- Minimal credential usage
- Fresh secret values for each workflow run
- Proper error handling at evaluation time

### Caching Strategy

- **No Persistent Caching**: Secrets are not cached between workflow runs
- **Expression-Level Caching**: Same vault/key combinations within a single
  evaluation are cached
- **Error Caching**: Failed lookups are not retried within the same evaluation

## Security Considerations

### Credential Management

- Never store AWS credentials in workflow files or version control
- Use IAM roles and policies for fine-grained access control
- Rotate credentials regularly and update vault configurations accordingly

### Secret Access Patterns

- Use descriptive but not revealing secret names
- Implement least-privilege access to specific secrets
- Monitor vault access through AWS CloudTrail or provider audit logs

### Expression Security

- Vault expressions are evaluated server-side only
- Vault secrets resolved via `vault.get()` are automatically redacted from
  stdout/stderr output, log files, and persisted data artifacts
- Redaction replaces secret values with `***` using the `SecretRedactor`
- The redactor is threaded through `MethodContext` and available to all model
  implementations
- Expression evaluation errors don't expose secret values

## 1Password Provider

The 1Password provider uses the `op` CLI to access secrets stored in 1Password
vaults.

### Authentication

- **Service Account Token**: `export OP_SERVICE_ACCOUNT_TOKEN=<token>`
  (recommended for CI/CD)
- **Desktop App**: Enable CLI integration in 1Password desktop app settings
  (recommended for local development)
- **Connect Server**: Set `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN` environment
  variables
- **Manual Sign-in**: `op signin` for interactive sessions

### Configuration Options

```yaml
# Created via: swamp vault create 1password my-vault --op-vault Engineering
type: "1password"
config:
  op_vault: "Engineering" # Required: 1Password vault name
  op_account: "my-team" # Optional: Account shorthand (multi-account)
```

### Secret Key Mapping

Secret keys are mapped to `op://` URIs:

| Expression                               | Maps to                                       | Notes                     |
| ---------------------------------------- | --------------------------------------------- | ------------------------- |
| `vault.get(my-1p, api-key)`              | `op read op://Engineering/api-key/password`   | Default field: `password` |
| `vault.get(my-1p, api-key/token)`        | `op read op://Engineering/api-key/token`      | Explicit field            |
| `vault.get(my-1p, db/connection/host)`   | `op read op://Engineering/db/connection/host` | Section + field           |
| `vault.get(my-1p, op://Shared/cert/pem)` | `op read op://Shared/cert/pem`                | Full `op://` override     |

### Usage Examples

```yaml
# Retrieve a secret using default "password" field
apiKey: ${{ vault.get(my-1p, api-key) }}

# Retrieve a specific field
dbHost: ${{ vault.get(my-1p, database/host) }}

# Override vault with full op:// URI
sharedCert: ${{ vault.get(my-1p, op://Shared/tls-cert/pem) }}
```

## Extensibility

The vault system is designed for easy extension to new providers:

### Adding New Vault Types

1. Implement the `VaultProvider` interface
2. Add configuration schema validation
3. Register the provider with the vault factory
4. Add provider-specific documentation

### Example: HashiCorp Vault Provider

```typescript
class HashiCorpVaultProvider implements VaultProvider {
  constructor(config: HashiCorpVaultConfig) {
    // Initialize with endpoint, token, mount path
  }

  async get(key: string): Promise<string> {
    // Implement HashiCorp Vault API calls
  }

  // ... other interface methods
}
```

### Future Vault Types

The architecture supports adding:

- **HashiCorp Vault**: Enterprise secret management
- **Google Secret Manager**: Google Cloud Platform secrets
- **Environment Variables**: Simple local development

## Error Handling

Comprehensive error handling covers:

### Configuration Errors

- Invalid vault names or missing configurations
- Malformed provider-specific settings
- Authentication credential issues

### Runtime Errors

- Network connectivity problems
- Secret not found in vault
- Permission denied accessing specific secrets
- Vault service unavailable

### Expression Evaluation Errors

- Vault name not found in configuration
- Invalid key format or characters
- Circular dependencies in vault expressions

All errors include:

- Clear error messages with context
- Vault name and key information (when safe to expose)
- Suggested resolution steps
- Reference to relevant documentation sections
