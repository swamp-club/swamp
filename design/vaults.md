# swamp vaults

A swamp vault is a secure storage system that allows workflows and models to
access sensitive data through named vault configurations. Vaults provide a clean
abstraction layer over different secret management systems, enabling secure data
retrieval and storage during workflow execution.

## Architecture

The vault system is built around a named vault architecture where:

- **Named Vaults**: Each vault instance has a user-defined name configured in
  `/.data/vault/{vault type}/{id}.yaml`
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
  vault.yaml   → symlink to /.data/vault/{vault-type}/{id}.yaml
  secrets/     → symlink to /.data/secrets/{vault-type}/{vault-name}/ (local vaults only)
```

Since vault names are unique across all types, the logical view uses a flat
structure that allows exploring vault definitions using human-readable names
without needing to know the vault type.

For vault types that store secrets locally (e.g., `local_encryption`), a
`secrets/` symlink is included to provide access to the encrypted secret files.
Remote vault types (e.g., `aws`) do not have a local secrets directory.

## Secret Storage

Vault secrets are stored in `.data/secrets/` organized by vault type and name:

```
.data/
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
full path is derived as `{base_dir}/.data/secrets/{vault-type}/{vault-name}/`.

## Vault Provider Interface

All vault implementations must implement the `VaultProvider` interface:

```typescript
interface VaultProvider {
  // Retrieve a secret value by key
  get(key: string): Promise<string>;

  // Store a secret value with the given key
  put(key: string, value: string): Promise<void>;

  // Validate the vault configuration
  validateConfig(): Promise<boolean>;
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

## Sensitive Field Marking

Model schemas can mark fields as sensitive using Zod's `.meta()` method:

```typescript
// Input schema with sensitive field
export const ApiKeyInputAttributesSchema = z.object({
  serviceName: z.string().min(1),
  keyData: z.string().meta({
    description: "Private key data for API authentication",
    sensitive: true,
    vault: true, // Indicates this should come from vault
  }),
});

// Data/Resource schema with sensitive output
export const ApiKeyDataAttributesSchema = z.object({
  serviceName: z.string(),
  apiKey: z.string().meta({
    description: "Generated API key",
    sensitive: true,
    vault: true, // Indicates this should be stored in vault
    vaultKey: "generated-api-key", // Optional: specify vault key name
  }),
  keyId: z.string(),
  createdAt: z.string().datetime(),
});
```

### Sensitive Field Metadata

Fields marked as sensitive support these metadata properties:

- `sensitive: boolean` - Marks the field as containing sensitive data
- `vault: boolean` - Indicates the field should interact with vault storage
- `vaultKey?: string` - Optional custom key name for vault storage (defaults to
  field name)
- `vaultName?: string` - Optional specific vault to use (defaults to repository
  default)

### Automatic Vault Integration

When a field is marked with `sensitive: true` and `vault: true`:

**Input Fields**: The swamp runtime automatically resolves vault expressions:

```yaml
# User writes this
keyData: ${{ vault.get(aws, machineKeyData) }}

# Runtime validates against schema and retrieves from vault
```

**Output Fields**: The swamp runtime automatically stores sensitive output:

```typescript
// After method execution, sensitive fields are automatically stored
// Field: apiKey with meta { sensitive: true, vault: true, vaultKey: "generated-api-key" }
// Result: vault.put(default-vault, "generated-api-key", resultData.attributes.apiKey)
```

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
  secretValue: ${{ model.api-generator.data.attributes.token }}
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
- Secret values are never logged or exposed in intermediate files
- Expression evaluation errors don't expose secret values

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
- **Azure Key Vault**: Microsoft cloud secrets
- **Google Secret Manager**: Google Cloud Platform secrets
- **Local File Vault**: Development and testing scenarios
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

## CLI Commands

### vault type search

Should work similarly to swamp type search - it uses fzf to search across all
the available vault types. Should produce json output or use interactive fuzzy
search.

### vault create <type> <name>

This will create a new vault of the specified type with the given name.

### vault search

Should work similarly to swamp vault type search - it uses fzf to search across
all the initialised vaults in the current repository. Should produce json output
or use interactive fuzzy search.

### vault get <model_id_or_name>

Shows the entire details of the vault configuration.

when specifying json, it should have the same content.

### vault edit [model_id_or_name]

Opens the vault config file in the user's preferred editor.

If no vault is specified interactively, shows a search interface.

Editor selection: Uses $EDITOR if set, otherwise falls back to: vscode, zed,
nvim, vim, nano, emacs.

### vault <vault_name> put KEY=VALUE

We should allow a user to be able to store a secret in the vault using the CLI.
This will error if there's no vault for that name. It should prompt a user if
they want to overwrite an existing secret if it exists.

### vault <vault_name> secret-list

This should list all of the secret names in the vault. It should NOT return any
values that go with them.
