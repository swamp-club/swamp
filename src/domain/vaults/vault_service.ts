import { parse } from "@std/yaml";
import type { VaultConfiguration, VaultProvider } from "./vault_provider.ts";
import { AwsVaultProvider } from "./aws_vault_provider.ts";
import { MockVaultProvider } from "./mock_vault_provider.ts";
import {
  type LocalEncryptionConfig,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";

/**
 * Interface for vault configuration in .swamp.yaml
 */
interface VaultConfig {
  type: string;
  config: Record<string, unknown>;
}

/**
 * Interface for the root configuration object
 */
interface SwampConfig {
  vaults?: Record<string, VaultConfig>;
}

/**
 * Service for managing vault providers and resolving vault operations.
 */
export class VaultService {
  private readonly providers = new Map<string, VaultProvider>();

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
          `Vault '${vaultName}' not found. No vaults are configured. ` +
            `Add vault configuration to your .swamp.yaml file:\n\n` +
            `vaults:\n` +
            `  ${vaultName}:\n` +
            `    type: aws  # or local_encryption\n` +
            `    config:\n` +
            `      region: us-east-1  # for aws\n` +
            `      # ssh_key_path: "~/.ssh/id_rsa"  # for local_encryption\n` +
            `      # auto_generate: true  # for local_encryption\n\n` +
            `Or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables for default vault.`,
        );
      } else {
        throw new Error(
          `Vault '${vaultName}' not found. Available vaults: ${
            availableVaults.join(", ")
          }. ` +
            `Add '${vaultName}' to your .swamp.yaml vault configuration.`,
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
          `Vault '${vaultName}' not found. No vaults are configured. ` +
            `Add vault configuration to your .swamp.yaml file.`,
        );
      } else {
        throw new Error(
          `Vault '${vaultName}' not found. Available vaults: ${
            availableVaults.join(", ")
          }. ` +
            `Add '${vaultName}' to your .swamp.yaml vault configuration.`,
        );
      }
    }

    await provider.put(secretKey, secretValue);
  }

  /**
   * Lists all registered vault names.
   */
  getVaultNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Creates a VaultService configured from a repository's .swamp.yaml file.
   *
   * @param repoDir - The repository directory containing .swamp.yaml
   * @returns A configured VaultService instance
   */
  static fromConfig(repoDir: string): VaultService {
    const vaultService = new VaultService();

    try {
      const configPath = `${repoDir}/.swamp.yaml`;
      const configText = Deno.readTextFileSync(configPath);
      const config = parse(configText) as SwampConfig;

      if (config.vaults) {
        for (const [name, vaultConfig] of Object.entries(config.vaults)) {
          vaultService.registerVault({
            name,
            type: vaultConfig.type,
            config: vaultConfig.config,
          });
        }
      }
    } catch (_error) {
      // Ignore file read errors - vault service will provide helpful error messages
    }

    vaultService.ensureDefaultVaults();
    return vaultService;
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
