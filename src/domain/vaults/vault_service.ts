import { getLogger } from "@logtape/logtape";
import type { VaultConfiguration, VaultProvider } from "./vault_provider.ts";
import { AwsVaultProvider } from "./aws_vault_provider.ts";
import { MockVaultProvider } from "./mock_vault_provider.ts";
import {
  type LocalEncryptionConfig,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";

/**
 * Service for managing vault providers and resolving vault operations.
 */
export class VaultService {
  private readonly providers = new Map<string, VaultProvider>();

  /**
   * Creates a VaultService instance loaded with vault configurations from the repository.
   * This is the preferred way to create a VaultService that should have access to
   * all configured vaults.
   *
   * Vaults are loaded from .swamp/vault/ directory (created via `swamp vault create`).
   * Note: Vaults are NOT configured in .swamp.yaml - use the CLI to create vaults.
   *
   * @param repoDir - The repository directory containing vault configurations
   * @returns A VaultService with all configured vaults loaded
   */
  static async fromRepository(repoDir: string): Promise<VaultService> {
    const vaultService = new VaultService();
    try {
      const vaultRepo = new YamlVaultConfigRepository(repoDir);
      const vaultConfigs = await vaultRepo.findAll();
      for (const vaultConfig of vaultConfigs) {
        vaultService.registerVault({
          name: vaultConfig.name,
          type: vaultConfig.type, // Let registerVault validate and throw for unsupported types
          config: vaultConfig.config,
        });
      }
    } catch (error) {
      // Repository may not exist yet, or vault config may be invalid
      getLogger("vaults").debug`Failed to load vault configs: ${error}`;
    }
    vaultService.ensureDefaultVaults();
    return vaultService;
  }

  /**
   * Registers a vault provider with the given configuration.
   */
  registerVault(config: VaultConfiguration): void {
    let provider: VaultProvider;

    switch (config.type.toLowerCase()) {
      case "aws":
        provider = new AwsVaultProvider(config.name, config.config);
        break;
      case "mock":
        provider = new MockVaultProvider(
          config.name,
          config.config as Record<string, string>,
        );
        break;
      case "local_encryption":
        provider = new LocalEncryptionVaultProvider(
          config.name,
          config.config as LocalEncryptionConfig,
        );
        break;
      default:
        throw new Error(`Unsupported vault type: ${config.type}`);
    }

    this.providers.set(config.name, provider);
  }

  /**
   * Gets a secret from the specified vault.
   */
  async get(vaultName: string, secretKey: string): Promise<string> {
    const provider = this.providers.get(vaultName);
    if (!provider) {
      const availableVaults = Array.from(this.providers.keys());
      if (availableVaults.length === 0) {
        throw new Error(
          `Vault '${vaultName}' not found. No vaults are configured.\n\n` +
            `Note: Vaults are NOT configured in .swamp.yaml. Create a vault using:\n` +
            `  swamp vault create <type> ${vaultName}\n\n` +
            `Available vault types: aws, local_encryption\n` +
            `Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for automatic AWS vault.`,
        );
      } else {
        throw new Error(
          `Vault '${vaultName}' not found. Available vaults: ${
            availableVaults.join(", ")
          }.\n` +
            `Create '${vaultName}' using: swamp vault create <type> ${vaultName}`,
        );
      }
    }

    return await provider.get(secretKey);
  }

  /**
   * Stores a secret in the specified vault.
   */
  async put(
    vaultName: string,
    secretKey: string,
    secretValue: string,
  ): Promise<void> {
    const provider = this.providers.get(vaultName);
    if (!provider) {
      const availableVaults = Array.from(this.providers.keys());
      if (availableVaults.length === 0) {
        throw new Error(
          `Vault '${vaultName}' not found. No vaults are configured.\n\n` +
            `Note: Vaults are NOT configured in .swamp.yaml. Create a vault using:\n` +
            `  swamp vault create <type> ${vaultName}\n\n` +
            `Available vault types: aws, local_encryption`,
        );
      } else {
        throw new Error(
          `Vault '${vaultName}' not found. Available vaults: ${
            availableVaults.join(", ")
          }.\n` +
            `Create '${vaultName}' using: swamp vault create <type> ${vaultName}`,
        );
      }
    }

    await provider.put(secretKey, secretValue);
  }

  /**
   * Lists all secret keys in the specified vault.
   * Returns only key names, not values.
   */
  async list(vaultName: string): Promise<string[]> {
    const provider = this.providers.get(vaultName);
    if (!provider) {
      const availableVaults = Array.from(this.providers.keys());
      if (availableVaults.length === 0) {
        throw new Error(
          `Vault '${vaultName}' not found. No vaults are configured.\n\n` +
            `Note: Vaults are NOT configured in .swamp.yaml. Create a vault using:\n` +
            `  swamp vault create <type> ${vaultName}\n\n` +
            `Available vault types: aws, local_encryption`,
        );
      } else {
        throw new Error(
          `Vault '${vaultName}' not found. Available vaults: ${
            availableVaults.join(", ")
          }.\n` +
            `Create '${vaultName}' using: swamp vault create <type> ${vaultName}`,
        );
      }
    }

    return await provider.list();
  }

  /**
   * Lists all registered vault names.
   */
  getVaultNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Creates default vaults if no vaults are configured and AWS credentials are available.
   * This allows automatic vault setup when credentials exist, but requires explicit
   * configuration when they don't.
   */
  ensureDefaultVaults(): void {
    if (this.providers.size === 0) {
      // Only auto-register if AWS credentials are explicitly available
      const hasAwsCredentials = Deno.env.get("AWS_ACCESS_KEY_ID") &&
        Deno.env.get("AWS_SECRET_ACCESS_KEY");

      if (hasAwsCredentials) {
        // Register default AWS vault only when credentials are explicitly set
        this.registerVault({
          name: "aws",
          type: "aws",
          config: {}, // Uses environment variables
        });
      }
      // If no credentials, leave providers empty to trigger helpful error messages
    }
  }
}
