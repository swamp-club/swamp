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
import { createVaultProvider } from "../../domain/vaults/vault_provider_factory.ts";
import { resolveVaultType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Data returned by the preview step. */
export interface VaultMigratePreview {
  vaultName: string;
  currentType: string;
  currentTypeName: string;
  targetType: string;
  targetTypeName: string;
  secretCount: number;
}

/** Data emitted on successful migration. */
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

/** Input for the vault migrate operation. */
export interface VaultMigrateInput {
  vaultName: string;
  targetType: string;
  targetConfig?: Record<string, unknown>;
  repoDir: string;
}

/** Dependencies for the vault migrate operation. */
export interface VaultMigrateDeps {
  findVaultConfig: (name: string) => Promise<VaultConfig | null>;
  resolveExtensionVaultType: (type: string) => Promise<void>;
  getVaultTypeInfo: (type: string) => VaultTypeInfo | undefined;
  createProvider: (
    type: string,
    name: string,
    config: Record<string, unknown>,
  ) => VaultProvider;
  loadSourceVaultService: () => Promise<VaultService>;
  saveConfig: (config: VaultConfig) => Promise<void>;
  deleteConfig: (config: VaultConfig) => Promise<void>;
  listAvailableTypes: () => string[];
}

/** Wires real infrastructure into VaultMigrateDeps. */
export async function createVaultMigrateDeps(
  repoDir: string,
): Promise<VaultMigrateDeps> {
  await vaultTypeRegistry.ensureLoaded();
  const repo = new YamlVaultConfigRepository(repoDir);
  return {
    findVaultConfig: (name) => repo.findByName(name),
    resolveExtensionVaultType: async (type) => {
      await vaultTypeRegistry.ensureTypeLoaded(type);
      if (!vaultTypeRegistry.has(type) && type.startsWith("@")) {
        await resolveVaultType(type, getAutoResolver());
      }
    },
    getVaultTypeInfo: (type) => vaultTypeRegistry.get(type),
    createProvider: createVaultProvider,
    loadSourceVaultService: () => VaultService.fromRepository(repoDir),
    saveConfig: (config) => repo.save(config),
    deleteConfig: (config) => repo.delete(config),
    listAvailableTypes: () => vaultTypeRegistry.getAll().map((v) => v.type),
  };
}

/**
 * Resolves provider-specific configuration for built-in vault types.
 */
function resolveBuiltInProviderConfig(
  vaultType: string,
  repoDir: string,
): Record<string, unknown> {
  switch (vaultType.toLowerCase()) {
    case "local_encryption":
      return {
        auto_generate: true,
        base_dir: repoDir,
      };
    default:
      return {};
  }
}

/** Gathers preview info for the vault migrate operation. */
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

  // Reject same-type migrations
  if (config.type.toLowerCase() === input.targetType.toLowerCase()) {
    throw validationFailed(
      `Vault '${input.vaultName}' is already using type '${config.type}'. ` +
        `Cannot migrate to the same type.`,
    );
  }

  // Check for renamed types
  const renamed = RENAMED_VAULT_TYPES[input.targetType.toLowerCase()];
  if (renamed) {
    throw validationFailed(
      `The type '${input.targetType}' has been renamed to '${renamed}'. Use type '${renamed}' instead.`,
    );
  }

  // Resolve and validate target type
  await deps.resolveExtensionVaultType(input.targetType);
  const targetTypeInfo = deps.getVaultTypeInfo(input.targetType);
  if (!targetTypeInfo) {
    const availableTypes = deps.listAvailableTypes().join(", ");
    throw validationFailed(
      `Unknown vault type: ${input.targetType}. Available types: ${availableTypes}. ` +
        `Use 'swamp vault type search' to see available types.`,
    );
  }

  // Validate target config
  const targetConfig = resolveTargetConfig(
    input.targetType,
    input.targetConfig,
    targetTypeInfo,
    input.repoDir,
  );

  // Verify we can create a provider for the target type (catches config issues early)
  deps.createProvider(input.targetType, input.vaultName, targetConfig);

  // Get current type info
  const currentTypeInfo = deps.getVaultTypeInfo(config.type);
  const currentTypeName = currentTypeInfo?.name ?? config.type;

  // Count secrets in source vault
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

/** Resolves and validates target config for the migration. */
function resolveTargetConfig(
  targetType: string,
  providedConfig: Record<string, unknown> | undefined,
  typeInfo: VaultTypeInfo,
  repoDir: string,
): Record<string, unknown> {
  if (!typeInfo.isBuiltIn && typeInfo.createProvider) {
    const config = providedConfig ?? {};
    if (typeInfo.configSchema) {
      const result = typeInfo.configSchema.safeParse(config);
      if (!result.success) {
        throw validationFailed(
          `Invalid config for vault type '${targetType}': ${result.error.message}`,
        );
      }
    }
    return config;
  }

  if (providedConfig) {
    return providedConfig;
  }

  return resolveBuiltInProviderConfig(targetType, repoDir);
}

/** Migrates a vault to a new backend type in-place. */
export async function* vaultMigrate(
  ctx: LibSwampContext,
  deps: VaultMigrateDeps,
  input: VaultMigrateInput,
): AsyncIterable<VaultMigrateEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.migrate",
    {},
    (async function* () {
      ctx.logger
        .debug`Migrating vault: ${input.vaultName} to ${input.targetType}`;

      // Load source vault config
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

      // Resolve target config
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
      );

      // Create target provider
      const targetProvider = deps.createProvider(
        input.targetType,
        input.vaultName,
        targetConfig,
      );

      // Load source vault service and copy secrets
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
          const value = await vaultService.get(input.vaultName, keys[i]);
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
  );
}
