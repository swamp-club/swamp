/**
 * Interface for vault providers that can securely store and retrieve secrets.
 */
export interface VaultProvider {
  /**
   * Retrieves a secret value from the vault.
   *
   * @param secretKey - The key identifier for the secret
   * @returns The secret value
   * @throws Error if the secret cannot be retrieved
   */
  get(secretKey: string): Promise<string>;

  /**
   * Stores a secret value in the vault.
   *
   * @param secretKey - The key identifier for the secret
   * @param secretValue - The secret value to store
   * @throws Error if the secret cannot be stored
   */
  put(secretKey: string, secretValue: string): Promise<void>;

  /**
   * Lists all secret keys in the vault.
   * Returns only the key names, not the secret values.
   *
   * @returns Array of secret key names
   */
  list(): Promise<string[]>;

  /**
   * Gets the name/type of this vault provider.
   */
  getName(): string;
}

/**
 * Configuration for vault providers.
 */
export interface VaultConfiguration {
  /** Vault provider name */
  name: string;
  /** Vault provider type (e.g., 'aws', 'hashicorp', 'azure') */
  type: string;
  /** Provider-specific configuration */
  config: Record<string, unknown>;
}
