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

import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import type { VaultProvider } from "../../domain/vaults/vault_provider.ts";
import {
  type VaultTypeInfo,
  vaultTypeRegistry,
} from "../../domain/vaults/vault_type_registry.ts";
import { RENAMED_VAULT_TYPES } from "../../domain/vaults/vault_types.ts";
import {
  defaultLocalEncryptionConfig,
  findNonDefaultKeySourceFields,
  isLocalEncryptionType,
  withRuntimeBaseDir,
  withServerDefaultKeySource,
} from "../../domain/vaults/local_encryption_key_source.ts";
import {
  findLocalEncryptionLeftovers,
  secretsDirForDisplay,
} from "../../domain/vaults/local_encryption_vault_provider.ts";
import { createVaultProvider } from "../../domain/vaults/vault_provider_factory.ts";
import {
  describeVaultConfigFields,
  explainVaultConfigIssues,
  type RerunHint,
  shellSingleQuote,
} from "../../domain/vaults/vault_config_fields.ts";
import {
  createRegistryConfigFieldsLookup,
  type RegistryConfigFieldsLookup,
} from "./config_fields.ts";
import { resolveVaultType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { leftoverSecretsError } from "./create.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface VaultMigratePreview {
  vaultName: string;
  currentType: string;
  currentTypeName: string;
  targetType: string;
  targetTypeName: string;
  secretCount: number;
}

export interface VaultMigrateData {
  vaultName: string;
  previousType: string;
  newType: string;
  newTypeName: string;
  secretsMigrated: number;
  timestamp: string;
}

export type VaultMigrateEvent =
  | { kind: "copying_secret"; index: number; total: number; key: string }
  | { kind: "updating_config" }
  | { kind: "completed"; data: VaultMigrateData }
  | { kind: "error"; error: SwampError };

export interface VaultMigrateInput {
  vaultName: string;
  targetType: string;
  targetConfig?: Record<string, unknown>;
  repoDir: string;
  /**
   * accepts a local_encryption target config that names its own key source;
   * only the local CLI, which owns the host, sets this. Otherwise such fields
   * are refused unless they match the server defaults
   */
  trustKeySource?: boolean;
}

export interface VaultMigrateDeps {
  findVaultConfig: (name: string) => Promise<VaultConfig | null>;
  isVaultTypeLoaded: (type: string) => Promise<boolean>;
  /**
   * the config fields the registry publishes for an extension type not
   * installed yet, so the CLI can ask for the missing ones before the install
   */
  findRegistryConfigFields: RegistryConfigFieldsLookup;
  resolveExtensionVaultType: (type: string) => Promise<void>;
  getVaultTypeInfo: (type: string) => VaultTypeInfo | undefined;
  createProvider: (
    type: string,
    name: string,
    config: Record<string, unknown>,
  ) => VaultProvider;
  /**
   * the storage directory a local_encryption vault of this name and config
   * would read, when an earlier vault left a key or secrets there
   */
  findLeftoverSecrets: (
    name: string,
    config: Record<string, unknown>,
  ) => Promise<string | undefined>;
  loadSourceVaultService: () => Promise<VaultService>;
  saveConfig: (config: VaultConfig) => Promise<void>;
  deleteConfig: (config: VaultConfig) => Promise<void>;
  listAvailableTypes: () => string[];
}

/**
 * serve passes its shared repository, whose mark hook signals saved and deleted
 * configs; the two options are exclusive because a repository already fixes its
 * vaults dir
 */
type VaultMigrateDepsOptions =
  | { vaultsDir?: string; repo?: never }
  | { repo: YamlVaultConfigRepository; vaultsDir?: never };

export async function createVaultMigrateDeps(
  repoDir: string,
  options?: VaultMigrateDepsOptions,
): Promise<VaultMigrateDeps> {
  await vaultTypeRegistry.ensureLoaded();
  const repo = options?.repo ??
    new YamlVaultConfigRepository(repoDir, undefined, options?.vaultsDir);
  return {
    findVaultConfig: (name) => repo.findByName(name),
    isVaultTypeLoaded: async (type) => {
      await vaultTypeRegistry.ensureTypeLoaded(type);
      return vaultTypeRegistry.has(type);
    },
    findRegistryConfigFields: createRegistryConfigFieldsLookup(
      getAutoResolver(),
    ),
    resolveExtensionVaultType: async (type) => {
      await vaultTypeRegistry.ensureTypeLoaded(type);
      if (!vaultTypeRegistry.has(type) && type.startsWith("@")) {
        await resolveVaultType(type, getAutoResolver());
      }
    },
    getVaultTypeInfo: (type) => vaultTypeRegistry.get(type),
    createProvider: createVaultProvider,
    findLeftoverSecrets: (name, config) =>
      findLocalEncryptionLeftovers(
        withRuntimeBaseDir("local_encryption", config, repoDir)
          .base_dir as string,
        name,
      ),
    loadSourceVaultService: () =>
      VaultService.fromRepository(repoDir, {
        vaultsDir: options?.vaultsDir,
      }),
    saveConfig: (config) => repo.save(config),
    deleteConfig: (config) => repo.delete(config),
    listAvailableTypes: () => vaultTypeRegistry.getAll().map((v) => v.type),
  };
}

function resolveBuiltInProviderConfig(
  vaultType: string,
): Record<string, unknown> {
  return isLocalEncryptionType(vaultType) ? defaultLocalEncryptionConfig() : {};
}

function migrateRerunHint(vaultName: string, targetType: string): RerunHint {
  return (example, missing) =>
    missing.length > 0
      ? `Re-run with: swamp vault migrate ${vaultName} --to-type ${targetType} --config ${
        shellSingleQuote(example)
      }`
      : "Re-run with a corrected --config.";
}

export async function vaultMigratePreview(
  ctx: LibSwampContext,
  deps: VaultMigrateDeps,
  input: VaultMigrateInput,
): Promise<VaultMigratePreview> {
  ctx.logger.debug`Previewing vault migration: ${input.vaultName}`;

  const config = await deps.findVaultConfig(input.vaultName);
  if (!config) {
    throw notFound(
      "Vault",
      `${input.vaultName}. Use 'swamp vault search' to see available vaults.`,
    );
  }

  if (config.type.toLowerCase() === input.targetType.toLowerCase()) {
    throw validationFailed(
      `Vault '${input.vaultName}' is already using type '${config.type}'. ` +
        `Cannot migrate to the same type.`,
    );
  }

  const renamed = RENAMED_VAULT_TYPES[input.targetType.toLowerCase()];
  if (renamed) {
    throw validationFailed(
      `The type '${input.targetType}' has been renamed to '${renamed}'. Use type '${renamed}' instead.`,
    );
  }

  const rerunHint = migrateRerunHint(input.vaultName, input.targetType);

  await deps.resolveExtensionVaultType(input.targetType);
  const targetTypeInfo = deps.getVaultTypeInfo(input.targetType);
  if (!targetTypeInfo) {
    const availableTypes = deps.listAvailableTypes().join(", ");
    throw validationFailed(
      `Unknown vault type: ${input.targetType}. Available types: ${availableTypes}. ` +
        `Use 'swamp vault type search' to see available types.`,
    );
  }

  const targetConfig = resolveTargetConfig(
    input.targetType,
    input.targetConfig,
    targetTypeInfo,
    input.repoDir,
    input.trustKeySource,
    input.vaultName,
    rerunHint,
  );

  deps.createProvider(
    input.targetType,
    input.vaultName,
    withRuntimeBaseDir(input.targetType, targetConfig, input.repoDir),
  );

  const leftover = await findLeftoverTarget(deps, input, targetConfig);
  if (leftover) throw leftover;

  const currentTypeInfo = deps.getVaultTypeInfo(config.type);
  const currentTypeName = currentTypeInfo?.name ?? config.type;

  const vaultService = await deps.loadSourceVaultService();
  const keys = await vaultService.list(input.vaultName);

  return {
    vaultName: input.vaultName,
    currentType: config.type,
    currentTypeName,
    targetType: input.targetType,
    targetTypeName: targetTypeInfo.name,
    secretCount: keys.length,
  };
}

/**
 * refuses a migration into local_encryption whose storage directory already
 * holds an earlier vault's key or secrets: the copied secrets would land beside
 * them under the old key
 */
async function findLeftoverTarget(
  deps: VaultMigrateDeps,
  input: VaultMigrateInput,
  targetConfig: Record<string, unknown>,
): Promise<SwampError | undefined> {
  if (!isLocalEncryptionType(input.targetType)) return undefined;
  const leftover = await deps.findLeftoverSecrets(
    input.vaultName,
    targetConfig,
  );
  return leftover === undefined ? undefined : leftoverSecretsError(
    "migrate",
    input.vaultName,
    secretsDirForDisplay(leftover, input.repoDir),
  );
}

function resolveTargetConfig(
  targetType: string,
  providedConfig: Record<string, unknown> | undefined,
  typeInfo: VaultTypeInfo,
  repoDir: string,
  trustKeySource: boolean | undefined,
  vaultName: string,
  rerunHint: RerunHint,
): Record<string, unknown> {
  if (!typeInfo.isBuiltIn && typeInfo.createProvider) {
    const config = providedConfig ?? {};
    if (typeInfo.configSchema) {
      const result = typeInfo.configSchema.safeParse(config);
      if (!result.success) {
        throw validationFailed(
          explainVaultConfigIssues({
            vaultType: targetType,
            config,
            issues: result.error.issues,
            fields: describeVaultConfigFields(typeInfo.configSchema),
            rerunHint,
          }),
        );
      }
    }
    return config;
  }

  if (providedConfig && !trustKeySource && isLocalEncryptionType(targetType)) {
    // The key source names files on this host, so a caller that does not
    // own it gets the server defaults.
    const refused = findNonDefaultKeySourceFields(providedConfig, repoDir);
    if (refused.length > 0) {
      throw validationFailed(
        `Cannot set ${refused.join(", ")} for vault '${vaultName}': a ` +
          `local_encryption vault migrated remotely uses the server's key ` +
          `source. Leave these fields out, or run the command on the host ` +
          `running swamp.`,
      );
    }
    return withServerDefaultKeySource(providedConfig);
  }

  if (providedConfig) {
    return providedConfig;
  }

  return resolveBuiltInProviderConfig(targetType);
}

export async function* vaultMigrate(
  ctx: LibSwampContext,
  deps: VaultMigrateDeps,
  input: VaultMigrateInput,
): AsyncIterable<VaultMigrateEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.vault.migrate",
      {},
      (async function* () {
        ctx.logger
          .debug`Migrating vault: ${input.vaultName} to ${input.targetType}`;

        const sourceConfig = await deps.findVaultConfig(input.vaultName);
        if (!sourceConfig) {
          yield {
            kind: "error",
            error: notFound("Vault", input.vaultName),
          };
          return;
        }

        // Same-type guard — prevent config deletion when source and target
        // paths are identical (saveConfig then deleteConfig on the same file).
        if (
          sourceConfig.type.toLowerCase() === input.targetType.toLowerCase()
        ) {
          yield {
            kind: "error",
            error: validationFailed(
              `Cannot migrate to the same type. Vault '${input.vaultName}' is already type '${sourceConfig.type}'.`,
            ),
          };
          return;
        }

        const rerunHint = migrateRerunHint(input.vaultName, input.targetType);

        await deps.resolveExtensionVaultType(input.targetType);
        const targetTypeInfo = deps.getVaultTypeInfo(input.targetType);
        if (!targetTypeInfo) {
          yield {
            kind: "error",
            error: validationFailed(
              `Unknown vault type: ${input.targetType}`,
            ),
          };
          return;
        }

        const targetConfig = resolveTargetConfig(
          input.targetType,
          input.targetConfig,
          targetTypeInfo,
          input.repoDir,
          input.trustKeySource,
          input.vaultName,
          rerunHint,
        );

        const leftover = await findLeftoverTarget(deps, input, targetConfig);
        if (leftover) {
          yield { kind: "error", error: leftover };
          return;
        }

        const targetProvider = deps.createProvider(
          input.targetType,
          input.vaultName,
          withRuntimeBaseDir(input.targetType, targetConfig, input.repoDir),
        );

        const vaultService = await deps.loadSourceVaultService();
        const keys = await vaultService.list(input.vaultName);

        try {
          for (let i = 0; i < keys.length; i++) {
            yield {
              kind: "copying_secret",
              index: i + 1,
              total: keys.length,
              key: keys[i],
            };
            const value = await vaultService.get(
              input.vaultName,
              keys[i],
              "cli:vault-migrate",
            );
            await targetProvider.put(keys[i], value);
            ctx.logger.debug`Copied secret ${i + 1}/${keys.length}`;
          }

          // Swap config: save new first, then delete old
          yield { kind: "updating_config" };
          const newConfig = VaultConfig.create(
            sourceConfig.id,
            sourceConfig.name,
            input.targetType,
            targetConfig,
          );
          await deps.saveConfig(newConfig);
          ctx.logger.debug`Saved new vault config`;

          try {
            await deps.deleteConfig(sourceConfig);
            ctx.logger.debug`Deleted old vault config`;
          } catch (deleteErr) {
            ctx.logger
              .warn`Failed to delete old vault config file (vault still works): ${deleteErr}`;
          }
        } catch (err) {
          yield {
            kind: "error",
            error: validationFailed(
              `Migration failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          };
          return;
        }

        yield {
          kind: "completed",
          data: {
            vaultName: input.vaultName,
            previousType: sourceConfig.type,
            newType: input.targetType,
            newTypeName: targetTypeInfo.name,
            secretsMigrated: keys.length,
            timestamp: new Date().toISOString(),
          },
        };
      })(),
    ));
}
