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
import { resolveVaultType } from "../extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import { MockVaultProvider } from "./mock_vault_provider.ts";
import {
  type LocalEncryptionConfig,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";
import { join } from "@std/path";
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
   * Vaults are loaded from the vaults/ directory (created via `swamp vault create`).
   * Note: Vaults are NOT configured in .swamp.yaml - use the CLI to create vaults.
   *
   * @param repoDir - The repository directory containing vault configurations
   * @returns A VaultService with all configured vaults loaded
   */
  static async fromRepository(
    repoDir: string,
    vaultsDir?: string,
  ): Promise<VaultService> {
    const vaultService = new VaultService();
    try {
      const effectiveVaultsDir = vaultsDir ?? join(repoDir, "vaults");
      const vaultRepo = new YamlVaultConfigRepository(
        repoDir,
        undefined,
        effectiveVaultsDir,
      );
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

        // Auto-resolve missing vault types from trusted collectives
        if (
          !vaultTypeRegistry.has(vaultType) && vaultType.startsWith("@")
        ) {
          await resolveVaultType(vaultType, getAutoResolver());
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
      assertVaultProvider(provider, config.type, config.name);
      this.providers.set(config.name, provider);
      return;
    }

    // Built-in types
    switch (config.type.toLowerCase()) {
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
            `For cloud vaults, install an extension first (e.g., swamp extension pull @swamp/aws-sm).`,
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
   * Hook for future default vault setup.
   * Previously auto-created an AWS vault when credentials were present,
   * but AWS is now an extension (@swamp/aws-sm). Install it with:
   *   swamp extension pull @swamp/aws-sm
   */
  ensureDefaultVaults(): void {
    // No-op — all external vault providers are now extensions.
    // Left in place to avoid breaking the fromRepository() call site.
  }
}

/**
 * Validates that an object returned by a user-defined createProvider implements
 * the VaultProvider interface. Throws a descriptive error if any required method
 * is missing or not a function.
 */
function assertVaultProvider(
  obj: unknown,
  vaultType: string,
  vaultName: string,
): asserts obj is VaultProvider {
  const required: (keyof VaultProvider)[] = ["get", "put", "list", "getName"];
  const missing: string[] = [];
  for (const method of required) {
    if (
      typeof obj !== "object" || obj === null ||
      typeof (obj as Record<string, unknown>)[method] !== "function"
    ) {
      missing.push(method);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `createProvider for vault type '${vaultType}' (vault '${vaultName}') returned an invalid provider: ` +
        `missing methods: ${missing.join(", ")}. ` +
        `A VaultProvider must implement get, put, list, and getName.`,
    );
  }
}

/**
 * Known renamed vault types and their current names.
 */
export const RENAMED_VAULT_TYPES: Record<string, string> = {
  "aws": "@swamp/aws-sm",
  "aws-sm": "@swamp/aws-sm",
  "azure": "@swamp/azure-kv",
  "azure-kv": "@swamp/azure-kv",
  "1password": "@swamp/1password",
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
