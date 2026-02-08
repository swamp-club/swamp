import type { VaultProvider } from "./vault_provider.ts";

/**
 * Mock vault provider for testing and demonstrations.
 * Returns predefined values for known secret keys.
 */
export class MockVaultProvider implements VaultProvider {
  private readonly secrets = new Map<string, string>();
  private readonly name: string;

  constructor(name: string, secrets: Record<string, string> = {}) {
    this.name = name;

    // Pre-populate with default secrets for testing
    this.secrets.set("demo-api-key", "super-secret-api-key-12345");
    this.secrets.set("demo-api-key-2", "another-secret-value-67890");
    this.secrets.set("derived-api-key", "derived-secret-value");

    // Add any provided secrets
    for (const [key, value] of Object.entries(secrets)) {
      this.secrets.set(key, value);
    }
  }

  get(secretKey: string): Promise<string> {
    const secret = this.secrets.get(secretKey);
    if (!secret) {
      throw new Error(
        `Secret '${secretKey}' not found in mock vault '${this.name}'`,
      );
    }
    return Promise.resolve(secret);
  }

  put(secretKey: string, secretValue: string): Promise<void> {
    this.secrets.set(secretKey, secretValue);
    return Promise.resolve();
  }

  getName(): string {
    return this.name;
  }

  list(): Promise<string[]> {
    return Promise.resolve(Array.from(this.secrets.keys()).sort());
  }

  /**
   * Adds a secret to the mock vault.
   */
  addSecret(key: string, value: string): void {
    this.secrets.set(key, value);
  }

  /**
   * Lists all available secrets (for testing).
   * @deprecated Use list() instead
   */
  listSecrets(): string[] {
    return Array.from(this.secrets.keys());
  }
}
