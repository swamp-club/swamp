// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { getLogger } from "@logtape/logtape";
import type { VaultConfiguration, VaultProvider } from "./vault_provider.ts";
import { getVaultTypes } from "./vault_types.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import { AwsVaultProvider } from "./aws_vault_provider.ts";
import {
  type AzureKvVaultConfig,
  AzureKvVaultProvider,
} from "./azure_kv_vault_provider.ts";
import { MockVaultProvider } from "./mock_vault_provider.ts";
import {
  type LocalEncryptionConfig,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";
import {
  type OnePasswordVaultConfig,
  OnePasswordVaultProvider,
} from "./onepassword_vault_provider.ts";
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
        // Auto-remap renamed vault types so old configs load transparently
        let vaultType = vaultConfig.type;
        const renamedTo = RENAMED_VAULT_TYPES[vaultType.toLowerCase()];
        if (renamedTo) {
          getLogger("vaults")
            .warn`Vault '${vaultConfig.name}' uses deprecated type '${vaultType}'. Automatically remapping to '${renamedTo}'. Update your vault config to use type: ${renamedTo}`;
          vaultType = renamedTo;
        }

        // For local_encryption vaults, inject base_dir from repoDir if not already set
        let config = vaultConfig.config;
        if (vaultType === "local_encryption") {
          const localConfig = config as LocalEncryptionConfig | undefined;
          if (!localConfig?.base_dir) {
            config = { ...localConfig, base_dir: repoDir };
          }
        }
        vaultService.registerVault({
          name: vaultConfig.name,
          type: vaultType,
          config,
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Unsupported vault type")
      ) {
        // Surface unsupported type errors as warnings so users see migration hints
        getLogger("vaults").warn`${error.message}`;
      } else {
        // Repository may not exist yet, or vault config may be invalid
        getLogger("vaults").debug`Failed to load vault configs: ${error}`;
      }
    }
    vaultService.ensureDefaultVaults();
    return vaultService;
  }

  /**
   * Registers a vault provider with the given configuration.
   */
  registerVault(config: VaultConfiguration): void {
    let provider: VaultProvider;

    // Check registry for user-defined types with a createProvider factory
    const registeredType = vaultTypeRegistry.get(config.type);
    if (registeredType?.createProvider && !registeredType.isBuiltIn) {
      // Validate config against schema if provided
      if (registeredType.configSchema) {
        const result = registeredType.configSchema.safeParse(config.config);
        if (!result.success) {
          throw new Error(
            `Invalid config for vault type '${config.type}' (vault '${config.name}'): ${result.error.message}`,
          );
        }
      }
      provider = registeredType.createProvider(config.name, config.config);
      this.providers.set(config.name, provider);
      return;
    }

    // Built-in types
    switch (config.type.toLowerCase()) {
      case "aws-sm":
        provider = new AwsVaultProvider(
          config.name,
          config.config as { region: string },
        );
        break;
      case "azure-kv":
        provider = new AzureKvVaultProvider(
          config.name,
          config.config as unknown as AzureKvVaultConfig,
        );
        break;
      case "mock":
        provider = new MockVaultProvider(
          config.name,
          config.config as Record<string, string>,
        );
        break;
      case "1password":
        provider = new OnePasswordVaultProvider(
          config.name,
          config.config as unknown as OnePasswordVaultConfig,
        );
        break;
      case "local_encryption":
        provider = new LocalEncryptionVaultProvider(
          config.name,
          config.config as LocalEncryptionConfig,
        );
        break;
      default: {
        const allTypes = vaultTypeRegistry.getAll().map((v) => v.type);
        throw new Error(
          `Unsupported vault type: '${config.type}' (vault '${config.name}').` +
            suggestVaultType(config.type, allTypes),
        );
      }
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
            `Available vault types: ${
              getVaultTypes().map((v) => v.type).join(", ")
            }\n` +
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
            `Available vault types: ${
              getVaultTypes().map((v) => v.type).join(", ")
            }`,
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
            `Available vault types: ${
              getVaultTypes().map((v) => v.type).join(", ")
            }`,
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

      const awsRegion = Deno.env.get("AWS_REGION");
      if (hasAwsCredentials && awsRegion) {
        // Register default AWS vault only when credentials and region are explicitly set
        this.registerVault({
          name: "aws-sm",
          type: "aws-sm",
          config: { region: awsRegion },
        });
      }
      // If no credentials, leave providers empty to trigger helpful error messages
    }
  }
}

/**
 * Known renamed vault types and their current names.
 */
const RENAMED_VAULT_TYPES: Record<string, string> = {
  aws: "aws-sm",
  azure: "azure-kv",
};

/**
 * Suggests the correct vault type name if the user provided a renamed or similar type.
 */
function suggestVaultType(type: string, allTypes?: string[]): string {
  const normalized = type.toLowerCase();
  const renamed = RENAMED_VAULT_TYPES[normalized];
  if (renamed) {
    return ` The type '${type}' has been renamed to '${renamed}'. Update your vault configuration to use type: ${renamed}`;
  }
  const available = allTypes?.join(", ") ??
    getVaultTypes().map((v) => v.type).join(", ");
  return ` Available vault types: ${available}`;
}
