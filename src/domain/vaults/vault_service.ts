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
import {
  isVaultDeleteProvider,
  type VaultConfiguration,
  type VaultProvider,
} from "./vault_provider.ts";
import {
  isVaultAnnotationProvider,
  type VaultAnnotation,
} from "./vault_annotation.ts";
import {
  isVaultRefreshHookProvider,
  type RefreshHook,
} from "./refresh_hook.ts";
import { getVaultTypes, RENAMED_VAULT_TYPES } from "./vault_types.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import { resolveVaultType } from "../extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import type { LocalEncryptionConfig } from "./local_encryption_vault_provider.ts";
import { join } from "@std/path";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { createVaultProvider } from "./vault_provider_factory.ts";
import { createVaultAuditEntry } from "./vault_audit_entry.ts";
import type { VaultAuditRepository } from "./vault_audit_repository.ts";

export interface ProcessRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface VaultRefreshOptions {
  runCommand: (command: string) => Promise<ProcessRunResult>;
}

/**
 * Service for managing vault providers and resolving vault operations.
 */
export class VaultService {
  private readonly providers = new Map<string, VaultProvider>();
  private readonly vaultTypes = new Map<string, string>();
  private readonly auditFlags = new Map<string, boolean>();
  private readonly refreshOptions?: VaultRefreshOptions;
  private auditRepository?: VaultAuditRepository;

  constructor(refreshOptions?: VaultRefreshOptions) {
    this.refreshOptions = refreshOptions;
  }

  setAuditRepository(repo: VaultAuditRepository): void {
    this.auditRepository = repo;
  }

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
    refreshOptions?: VaultRefreshOptions,
  ): Promise<VaultService> {
    await vaultTypeRegistry.ensureLoaded();
    const vaultService = new VaultService(refreshOptions);
    let vaultConfigs: Awaited<
      ReturnType<YamlVaultConfigRepository["findAll"]>
    >;
    try {
      const effectiveVaultsDir = vaultsDir ?? join(repoDir, "vaults");
      const vaultRepo = new YamlVaultConfigRepository(
        repoDir,
        undefined,
        effectiveVaultsDir,
      );
      vaultConfigs = await vaultRepo.findAll();
    } catch (error) {
      getLogger("vaults").debug`Failed to load vault configs: ${error}`;
      vaultService.ensureDefaultVaults();
      return vaultService;
    }
    for (const vaultConfig of vaultConfigs) {
      try {
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
          auditReads: vaultConfig.auditReads,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Unsupported vault type")
        ) {
          getLogger("vaults").warn`${error.message}`;
        } else {
          getLogger("vaults")
            .warn`Failed to load vault '${vaultConfig.name}': ${error}`;
        }
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
    this.vaultTypes.set(config.name, config.type);
    if (config.auditReads) {
      this.auditFlags.set(config.name, true);
    }
  }

  /**
   * Gets a secret from the specified vault. When a refresh hook is configured
   * on the key and refreshOptions were provided, transparently re-runs the
   * refresh command when the TTL has lapsed.
   */
  async get(
    vaultName: string,
    secretKey: string,
    callerContext?: string,
  ): Promise<string> {
    const provider = this.requireProvider(vaultName);

    if (this.refreshOptions && isVaultRefreshHookProvider(provider)) {
      const hook = await provider.getRefreshHook(secretKey);
      if (hook && hook.isStale()) {
        try {
          const result = await this.refreshOptions.runCommand(hook.command);
          if (result.success) {
            const freshValue = result.stdout.trimEnd();
            if (freshValue.length === 0) {
              getLogger("vaults")
                .warn`Refresh command for ${secretKey} in vault ${vaultName} succeeded but produced empty output. Returning stale value.`;
            } else {
              await provider.put(secretKey, freshValue);
              await provider.putRefreshHook(
                secretKey,
                hook.withRefreshedAt(new Date()),
              );
              getLogger("vaults")
                .info`Refreshed secret ${secretKey} in vault ${vaultName}`;
              await this.recordAuditEntry(
                vaultName,
                secretKey,
                callerContext,
              );
              return freshValue;
            }
          } else {
            getLogger("vaults")
              .warn`Refresh command failed for ${secretKey} in vault ${vaultName}: ${result.stderr}. Returning stale value.`;
          }
        } catch (error) {
          getLogger("vaults")
            .warn`Refresh command error for ${secretKey} in vault ${vaultName}: ${error}. Returning stale value.`;
        }
      }
    }

    const value = await provider.get(secretKey);
    await this.recordAuditEntry(
      vaultName,
      secretKey,
      callerContext,
    );
    return value;
  }

  private async recordAuditEntry(
    vaultName: string,
    secretKey: string,
    callerContext?: string,
  ): Promise<void> {
    if (!this.auditRepository || !this.auditFlags.get(vaultName)) return;
    try {
      const vaultType = this.vaultTypes.get(vaultName) ?? "unknown";
      const entry = createVaultAuditEntry(
        vaultName,
        vaultType,
        secretKey,
        callerContext ?? "unknown",
      );
      await this.auditRepository.append(entry);
    } catch (error) {
      getLogger("vaults")
        .warn`Failed to record vault audit entry for ${secretKey} in ${vaultName}: ${error}`;
    }
  }

  private requireProvider(vaultName: string): VaultProvider {
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
      }
      throw new Error(
        `Vault '${vaultName}' not found. Available vaults: ${
          availableVaults.join(", ")
        }.\n` +
          `Create '${vaultName}' using: swamp vault create <type> ${vaultName}`,
      );
    }
    return provider;
  }

  /**
   * Stores a secret in the specified vault.
   */
  async put(
    vaultName: string,
    secretKey: string,
    secretValue: string,
  ): Promise<void> {
    const provider = this.requireProvider(vaultName);
    await provider.put(secretKey, secretValue);
  }

  async delete(vaultName: string, secretKey: string): Promise<void> {
    const provider = this.requireDeleteProvider(vaultName);
    await provider.delete(secretKey);
  }

  supportsDelete(vaultName: string): boolean {
    const provider = this.providers.get(vaultName);
    if (!provider) return false;
    return isVaultDeleteProvider(provider);
  }

  private requireDeleteProvider(vaultName: string) {
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
    if (!isVaultDeleteProvider(provider)) {
      throw new Error(
        `Vault '${vaultName}' (type: ${provider.getName()}) does not support deleting secrets`,
      );
    }
    return provider;
  }

  /**
   * Lists all secret keys in the specified vault.
   * Returns only key names, not values.
   */
  async list(vaultName: string): Promise<string[]> {
    const provider = this.requireProvider(vaultName);
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

  supportsRefreshHooks(vaultName: string): boolean {
    const provider = this.providers.get(vaultName);
    if (!provider) return false;
    return isVaultRefreshHookProvider(provider);
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

  async getRefreshHook(
    vaultName: string,
    secretKey: string,
  ): Promise<RefreshHook | null> {
    const provider = this.requireRefreshHookProvider(vaultName);
    return await provider.getRefreshHook(secretKey);
  }

  async putRefreshHook(
    vaultName: string,
    secretKey: string,
    hook: RefreshHook,
  ): Promise<void> {
    const provider = this.requireRefreshHookProvider(vaultName);
    await provider.putRefreshHook(secretKey, hook);
  }

  async deleteRefreshHook(
    vaultName: string,
    secretKey: string,
  ): Promise<void> {
    const provider = this.requireRefreshHookProvider(vaultName);
    await provider.deleteRefreshHook(secretKey);
  }

  private requireRefreshHookProvider(vaultName: string) {
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
    if (!isVaultRefreshHookProvider(provider)) {
      throw new Error(
        `Vault '${vaultName}' (type: ${provider.getName()}) does not support refresh hooks`,
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
