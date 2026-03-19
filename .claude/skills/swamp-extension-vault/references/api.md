# API Reference — Extension Vaults

Full interface documentation for implementing custom vault providers.

Source files:

- `src/domain/vaults/vault_provider.ts`
- `src/domain/vaults/user_vault_loader.ts`

## VaultProvider

Interface returned by `createProvider`. Implementations provide methods for
securely storing and retrieving secrets.

```typescript
interface VaultProvider {
  get(secretKey: string): Promise<string>;
  put(secretKey: string, secretValue: string): Promise<void>;
  list(): Promise<string[]>;
  getName(): string;
}
```

### `get(secretKey)`

Retrieves a secret value from the vault.

- `secretKey` — the key identifier for the secret
- Returns the secret value as a string
- Throws `Error` if the secret cannot be retrieved (not found, access denied,
  network error, etc.)

### `put(secretKey, secretValue)`

Stores a secret value in the vault.

- `secretKey` — the key identifier for the secret
- `secretValue` — the secret value to store
- Throws `Error` if the secret cannot be stored

### `list()`

Lists all secret keys in the vault. Returns only key names, **not** the secret
values themselves.

- Returns an array of secret key name strings
- Throws `Error` if the listing operation fails

### `getName()`

Returns the name of this vault instance. This is the `name` parameter passed to
`createProvider` — typically the vault instance name from `.swamp.yaml`.

## VaultConfiguration

Configuration structure used when configuring vaults.

```typescript
interface VaultConfiguration {
  name: string; // Vault instance name
  type: string; // Vault provider type (e.g., "@myorg/custom-vault")
  config: Record<string, unknown>; // Provider-specific configuration
}
```

## User Vault Export Schema

The object exported as `export const vault` is validated against this schema:

```typescript
{
  type: string;           // Must match @collective/name or collective/name
  name: string;           // Human-readable display name
  description: string;    // What this vault does
  configSchema?: ZodType; // Optional Zod schema for config validation
  createProvider: (name: string, config: Record<string, unknown>) => VaultProvider;
}
```

### `type`

Namespaced identifier for the vault type. Must match the pattern
`@collective/name` or `collective/name`. Examples: `@myorg/hashicorp-vault`,
`myorg/aws-sm`. Reserved collectives (`swamp`, `si`) cannot be used.

### `name`

Human-readable display name shown in CLI output and status commands.

### `description`

Short description of what this vault does. Shown in extension listings and
search results.

### `configSchema`

Optional Zod schema for validating the `config` section from `.swamp.yaml`. When
provided, swamp validates configuration before calling `createProvider`. If
omitted, the raw config object is passed through without validation.

### `createProvider(name, config)`

Factory function that creates a `VaultProvider` instance.

- `name` — the vault instance name (from `.swamp.yaml` vault configuration)
- `config` — the provider-specific configuration object (validated against
  `configSchema` if provided)
- Returns a `VaultProvider` implementation
