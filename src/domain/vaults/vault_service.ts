// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import {
  isVaultAnnotationProvider,
  type VaultAnnotation,
} from "./vault_annotation.ts";
import { getVaultTypes, RENAMED_VAULT_TYPES } from "./vault_types.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import { resolveVaultType } from "../extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import type { LocalEncryptionConfig } from "./local_encryption_vault_provider.ts";
import { join } from "@std/path";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { createVaultProvider } from "./vault_provider_factory.ts";

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
    await vaultTypeRegistry.ensureLoaded();
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
        await vaultTypeRegistry.ensureTypeLoaded(vaultType);
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
    const provider = createVaultProvider(
      config.type,
      config.name,
      config.config,
    );
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

  async getAnnotation(
    vaultName: string,
    secretKey: string,
  ): Promise<VaultAnnotation | null> {
    const provider = this.requireAnnotationProvider(vaultName);
    return await provider.getAnnotation(secretKey);
  }

  async putAnnotation(
    vaultName: string,
    secretKey: string,
    annotation: VaultAnnotation,
  ): Promise<void> {
    const provider = this.requireAnnotationProvider(vaultName);
    await provider.putAnnotation(secretKey, annotation);
  }

  async deleteAnnotation(
    vaultName: string,
    secretKey: string,
  ): Promise<void> {
    const provider = this.requireAnnotationProvider(vaultName);
    await provider.deleteAnnotation(secretKey);
  }

  supportsAnnotations(vaultName: string): boolean {
    const provider = this.providers.get(vaultName);
    if (!provider) return false;
    return isVaultAnnotationProvider(provider);
  }

  private requireAnnotationProvider(vaultName: string) {
    const provider = this.providers.get(vaultName);
    if (!provider) {
      const availableVaults = Array.from(this.providers.keys());
      if (availableVaults.length === 0) {
        throw new Error(
          `Vault '${vaultName}' not found. No vaults are configured.`,
        );
      }
      throw new Error(
        `Vault '${vaultName}' not found. Available vaults: ${
          availableVaults.join(", ")
        }`,
      );
    }
    if (!isVaultAnnotationProvider(provider)) {
      throw new Error(
        `Vault '${vaultName}' (type: ${provider.getName()}) does not support annotations`,
      );
    }
    return provider;
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
