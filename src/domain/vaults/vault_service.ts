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
  isVaultExistenceProvider,
  type VaultConfiguration,
  type VaultProvider,
  type VaultPutOptions,
} from "./vault_provider.ts";
import {
  isVaultAnnotationProvider,
  type VaultAnnotation,
} from "./vault_annotation.ts";
import {
  isVaultRefreshHookProvider,
  type RefreshHook,
} from "./refresh_hook.ts";
import {
  isReservedVaultName,
  reservedVaultNameMessage,
  vaultCreateHint,
} from "./vault_name.ts";
import { getVaultTypes, RENAMED_VAULT_TYPES } from "./vault_types.ts";
import { vaultTypeRegistry } from "./vault_type_registry.ts";
import { resolveVaultType } from "../extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import { withRuntimeBaseDir } from "./local_encryption_key_source.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { createVaultProvider } from "./vault_provider_factory.ts";
import {
  createVaultAuditEntry,
  type VaultAuditAction,
} from "./vault_audit_entry.ts";
import type { VaultAuditRepository } from "./vault_audit_repository.ts";
import { JsonlVaultAuditRepository } from "../../infrastructure/persistence/jsonl_vault_audit_repository.ts";
import {
  currentVaultAccess,
  type RunVaultMethod,
  type VaultAction,
} from "./run_vault_access.ts";

export interface ProcessRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface VaultRefreshOptions {
  runCommand: (command: string) => Promise<ProcessRunResult>;
}

/**
 * Holds a vault operation to the current run vault access scope, if any,
 * before any provider is touched. Without a scope it does nothing.
 */
async function authorizeVaultAction(
  vaultName: string,
  action: VaultAction,
  method: RunVaultMethod,
  secretKey?: string,
): Promise<void> {
  const access = currentVaultAccess();
  if (access) await access.check(vaultName, action, method, secretKey);
}

/**
 * every per-vault method, read or write, is decided against the run vault
 * access scope before the provider is reached
 */
export class VaultService {
  static readonly #globalProviders = new Map<
    string,
    { type: string; provider: VaultProvider }
  >();

  static registerGlobalProvider(
    name: string,
    type: string,
    provider: VaultProvider,
  ): void {
    VaultService.#globalProviders.set(name, { type, provider });
  }

  /**
   * Removes a provider added with {@link registerGlobalProvider}. VaultService
   * instances created earlier keep it; later ones no longer see it.
   */
  static unregisterGlobalProvider(name: string): void {
    VaultService.#globalProviders.delete(name);
  }

  private readonly providers = new Map<string, VaultProvider>();
  private readonly vaultTypes = new Map<string, string>();
  private readonly auditFlags = new Map<string, boolean>();
  private readonly refreshOptions?: VaultRefreshOptions;
  private auditRepository?: VaultAuditRepository;
  private readonly configuredDefaultVault?: string;

  constructor(
    refreshOptions?: VaultRefreshOptions,
    defaultVaultName?: string,
  ) {
    this.refreshOptions = refreshOptions;
    this.configuredDefaultVault = defaultVaultName;
  }

  setAuditRepository(repo: VaultAuditRepository): void {
    this.auditRepository = repo;
  }

  static async fromRepository(
    repoDir: string,
    options?: {
      vaultsDir?: string;
      refreshOptions?: VaultRefreshOptions;
      defaultVaultName?: string;
      signal?: AbortSignal;
    },
  ): Promise<VaultService> {
    options?.signal?.throwIfAborted();
    await vaultTypeRegistry.ensureLoaded();
    options?.signal?.throwIfAborted();
    const vaultService = new VaultService(
      options?.refreshOptions,
      options?.defaultVaultName,
    );
    let vaultConfigs: Awaited<
      ReturnType<YamlVaultConfigRepository["findAll"]>
    >;
    try {
      // Without an explicit vaultsDir the repository resolves the effective
      // vaults dir itself, which honours managedConfig.
      const vaultRepo = new YamlVaultConfigRepository(
        repoDir,
        undefined,
        options?.vaultsDir,
      );
      vaultConfigs = await vaultRepo.findAll();
      options?.signal?.throwIfAborted();
    } catch (error) {
      options?.signal?.throwIfAborted();
      getLogger("vaults").debug`Failed to load vault configs: ${error}`;
      vaultService.ensureDefaultVaults();
      return vaultService;
    }
    for (const vaultConfig of vaultConfigs) {
      try {
        let vaultType = vaultConfig.type;
        const renamedTo = RENAMED_VAULT_TYPES[vaultType.toLowerCase()];
        if (renamedTo) {
          getLogger("vaults")
            .warn`Vault '${vaultConfig.name}' uses deprecated type '${vaultType}'. Automatically remapping to '${renamedTo}'. Update your vault config to use type: ${renamedTo}`;
          vaultType = renamedTo;
        }

        await vaultTypeRegistry.ensureTypeLoaded(vaultType);
        options?.signal?.throwIfAborted();
        if (
          !vaultTypeRegistry.has(vaultType) && vaultType.startsWith("@")
        ) {
          await resolveVaultType(vaultType, getAutoResolver());
          options?.signal?.throwIfAborted();
        }

        vaultService.registerVault({
          name: vaultConfig.name,
          type: vaultType,
          config: withRuntimeBaseDir(vaultType, vaultConfig.config, repoDir),
          auditReads: vaultConfig.auditReads,
        });
      } catch (error) {
        options?.signal?.throwIfAborted();
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
    for (const [name, { type, provider }] of VaultService.#globalProviders) {
      if (!vaultService.providers.has(name)) {
        vaultService.providers.set(name, provider);
        vaultService.vaultTypes.set(name, type);
      }
    }
    vaultService.ensureDefaultVaults();
    vaultService.setAuditRepository(
      new JsonlVaultAuditRepository(repoDir),
    );
    return vaultService;
  }

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

  /** cancellation cannot interrupt a provider call; providers take no signal */
  async get(
    vaultName: string,
    secretKey: string,
    callerContext?: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    options?.signal?.throwIfAborted();
    await authorizeVaultAction(vaultName, "read", "get", secretKey);
    options?.signal?.throwIfAborted();
    const provider = this.requireProvider(vaultName);

    if (this.refreshOptions && isVaultRefreshHookProvider(provider)) {
      const hook = await provider.getRefreshHook(secretKey);
      options?.signal?.throwIfAborted();
      if (hook && hook.isStale()) {
        try {
          const result = await this.refreshOptions.runCommand(hook.command);
          options?.signal?.throwIfAborted();
          if (result.success) {
            const freshValue = result.stdout.trimEnd();
            if (freshValue.length === 0) {
              getLogger("vaults")
                .warn`Refresh command for ${secretKey} in vault ${vaultName} succeeded but produced empty output. Returning stale value.`;
            } else {
              await provider.put(secretKey, freshValue);
              options?.signal?.throwIfAborted();
              await provider.putRefreshHook(
                secretKey,
                hook.withRefreshedAt(new Date()),
              );
              options?.signal?.throwIfAborted();
              getLogger("vaults")
                .info`Refreshed secret ${secretKey} in vault ${vaultName}`;
              await this.recordAuditEntry(
                "get",
                vaultName,
                secretKey,
                callerContext,
              );
              options?.signal?.throwIfAborted();
              return freshValue;
            }
          } else {
            // Never the command's output or a cause: a refresh command
            // prints the secret it mints, so its stderr can carry one.
            getLogger("vaults")
              .warn`Refresh command failed for ${secretKey} in vault ${vaultName}. Returning stale value; run the refresh command by hand to see its output.`;
          }
        } catch {
          options?.signal?.throwIfAborted();
          getLogger("vaults")
            .warn`Refresh command error for ${secretKey} in vault ${vaultName}. Returning stale value; run the refresh command by hand to see why it failed.`;
        }
      }
    }

    const value = await provider.get(secretKey);
    options?.signal?.throwIfAborted();
    await this.recordAuditEntry(
      "get",
      vaultName,
      secretKey,
      callerContext,
    );
    options?.signal?.throwIfAborted();
    return value;
  }

  private async recordAuditEntry(
    action: VaultAuditAction,
    vaultName: string,
    secretKey: string,
    callerContext?: string,
  ): Promise<void> {
    if (!this.auditRepository) return;
    if (action === "get" && !this.auditFlags.get(vaultName)) return;
    try {
      const vaultType = this.vaultTypes.get(vaultName) ?? "unknown";
      const entry = createVaultAuditEntry(
        action,
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

  /**
   * capability errors name the configured type from here, not
   * provider.getName(), which built-in providers answer with the vault's
   * instance name
   */
  private vaultTypeOf(vaultName: string): string {
    return this.vaultTypes.get(vaultName) ?? "unknown";
  }

  private requireProvider(vaultName: string): VaultProvider {
    const provider = this.providers.get(vaultName);
    if (!provider) {
      if (isReservedVaultName(vaultName)) {
        throw new Error(
          `Vault '${vaultName}' is not available. ${
            reservedVaultNameMessage(vaultName)
          }`,
        );
      }
      const availableVaults = Array.from(this.providers.keys());
      if (availableVaults.length === 0) {
        throw new Error(
          `Vault '${vaultName}' not found. No vaults are configured.\n\n` +
            `Note: Vaults are NOT configured in .swamp.yaml. ${
              vaultCreateHint(vaultName)
            }\n\n` +
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
          vaultCreateHint(vaultName),
      );
    }
    return provider;
  }

  async put(
    vaultName: string,
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
    callerContext?: string,
  ): Promise<void> {
    await authorizeVaultAction(vaultName, "write", "put", secretKey);
    const provider = this.requireProvider(vaultName);
    await provider.put(secretKey, secretValue, options);
    await this.recordAuditEntry("put", vaultName, secretKey, callerContext);
  }

  async delete(
    vaultName: string,
    secretKey: string,
    callerContext?: string,
  ): Promise<void> {
    await authorizeVaultAction(vaultName, "write", "delete", secretKey);
    const provider = this.requireDeleteProvider(vaultName);
    await provider.delete(secretKey);
    await this.recordAuditEntry("delete", vaultName, secretKey, callerContext);
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
        `Vault '${vaultName}' (type: ${
          this.vaultTypeOf(vaultName)
        }) does not support deleting secrets`,
      );
    }
    return provider;
  }

  /**
   * held to the run vault access scope as a read, so a principal that cannot
   * read a key cannot learn it exists; runs no refresh hook and records no
   * audit entry, so it reports what is stored now
   */
  async has(vaultName: string, secretKey: string): Promise<boolean> {
    await authorizeVaultAction(vaultName, "read", "get", secretKey);
    const provider = this.requireExistenceProvider(vaultName);
    return await provider.has(secretKey);
  }

  /**
   * the existence check calls it for a reference it already confirmed, because
   * a grant can be revoked mid-run
   */
  async authorizeRead(vaultName: string, secretKey: string): Promise<void> {
    await authorizeVaultAction(vaultName, "read", "get", secretKey);
  }

  supportsExistenceCheck(vaultName: string): boolean {
    const provider = this.providers.get(vaultName);
    if (!provider) return false;
    return isVaultExistenceProvider(provider);
  }

  private requireExistenceProvider(vaultName: string) {
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
    if (!isVaultExistenceProvider(provider)) {
      throw new Error(
        `Vault '${vaultName}' (type: ${
          this.vaultTypeOf(vaultName)
        }) does not support existence checks`,
      );
    }
    return provider;
  }

  async list(vaultName: string): Promise<string[]> {
    await authorizeVaultAction(vaultName, "read", "list-keys");
    const provider = this.requireProvider(vaultName);
    return await provider.list();
  }

  async getAnnotation(
    vaultName: string,
    secretKey: string,
  ): Promise<VaultAnnotation | null> {
    await authorizeVaultAction(vaultName, "read", "describe", secretKey);
    const provider = this.requireAnnotationProvider(vaultName);
    return await provider.getAnnotation(secretKey);
  }

  async putAnnotation(
    vaultName: string,
    secretKey: string,
    annotation: VaultAnnotation,
    callerContext?: string,
  ): Promise<void> {
    await authorizeVaultAction(vaultName, "write", "annotate", secretKey);
    const provider = this.requireAnnotationProvider(vaultName);
    await provider.putAnnotation(secretKey, annotation);
    await this.recordAuditEntry(
      "annotate",
      vaultName,
      secretKey,
      callerContext,
    );
  }

  async deleteAnnotation(
    vaultName: string,
    secretKey: string,
    callerContext?: string,
  ): Promise<void> {
    await authorizeVaultAction(vaultName, "write", "annotate", secretKey);
    const provider = this.requireAnnotationProvider(vaultName);
    await provider.deleteAnnotation(secretKey);
    await this.recordAuditEntry(
      "annotate",
      vaultName,
      secretKey,
      callerContext,
    );
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
        `Vault '${vaultName}' (type: ${
          this.vaultTypeOf(vaultName)
        }) does not support annotations`,
      );
    }
    return provider;
  }

  async getRefreshHook(
    vaultName: string,
    secretKey: string,
  ): Promise<RefreshHook | null> {
    await authorizeVaultAction(vaultName, "read", "describe", secretKey);
    const provider = this.requireRefreshHookProvider(vaultName);
    return await provider.getRefreshHook(secretKey);
  }

  async putRefreshHook(
    vaultName: string,
    secretKey: string,
    hook: RefreshHook,
  ): Promise<void> {
    await authorizeVaultAction(vaultName, "write", "edit", secretKey);
    const provider = this.requireRefreshHookProvider(vaultName);
    await provider.putRefreshHook(secretKey, hook);
  }

  async deleteRefreshHook(
    vaultName: string,
    secretKey: string,
  ): Promise<void> {
    await authorizeVaultAction(vaultName, "write", "edit", secretKey);
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
        `Vault '${vaultName}' (type: ${
          this.vaultTypeOf(vaultName)
        }) does not support refresh hooks`,
      );
    }
    return provider;
  }

  getVaultNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * leaves out reserved internal vaults, which never accept user data; use
   * this, not getVaultNames, to decide whether a vault is available for user
   * data
   */
  getUserVaultNames(): string[] {
    return this.getVaultNames().filter((name) => !isReservedVaultName(name));
  }

  getDefaultVaultName(): string | undefined {
    if (
      this.configuredDefaultVault !== undefined &&
      this.providers.has(this.configuredDefaultVault)
    ) {
      return this.configuredDefaultVault;
    }
    return undefined;
  }

  ensureDefaultVaults(): void {
    // No-op — all external vault providers are now extensions.
    // Left in place to avoid breaking the fromRepository() call site.
  }
}
