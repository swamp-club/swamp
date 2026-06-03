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

import {
  createVaultConfigId,
  VaultConfig,
} from "../../domain/vaults/vault_config.ts";
import {
  type VaultTypeInfo,
  vaultTypeRegistry,
} from "../../domain/vaults/vault_type_registry.ts";
import { RENAMED_VAULT_TYPES } from "../../domain/vaults/vault_types.ts";
import { resolveVaultType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { alreadyExists, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the vault create output.
 */
export interface VaultCreateData {
  id: string;
  name: string;
  type: string;
  typeName: string;
  config: Record<string, unknown>;
}

export type VaultCreateEvent =
  | { kind: "creating" }
  | { kind: "completed"; data: VaultCreateData }
  | { kind: "error"; error: SwampError };

/** Input for the vault create operation. */
export interface VaultCreateInput {
  vaultType: string;
  name: string;
  config?: Record<string, unknown>;
  repoDir: string;
}

/** Dependencies for the vault create operation. */
export interface VaultCreateDeps {
  resolveExtensionVaultType: (type: string) => Promise<void>;
  getVaultTypeInfo: (type: string) => VaultTypeInfo | undefined;
  findByName: (name: string) => Promise<boolean>;
  save: (config: VaultConfig) => Promise<void>;
  listAvailableTypes: () => string[];
}

/** Wires real infrastructure into VaultCreateDeps. */
export async function createVaultCreateDeps(
  repoDir: string,
): Promise<VaultCreateDeps> {
  await vaultTypeRegistry.ensureLoaded();
  const repo = new YamlVaultConfigRepository(repoDir);
  return {
    resolveExtensionVaultType: async (type) => {
      await vaultTypeRegistry.ensureTypeLoaded(type);
      if (!vaultTypeRegistry.has(type) && type.startsWith("@")) {
        await resolveVaultType(type, getAutoResolver());
      }
    },
    getVaultTypeInfo: (type) => vaultTypeRegistry.get(type),
    findByName: async (name) => {
      const existing = await repo.findByName(name);
      return existing !== null;
    },
    save: (config) => repo.save(config),
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
  switch (vaultType) {
    case "local_encryption":
      return {
        auto_generate: true,
        base_dir: repoDir,
      };
    default:
      return {};
  }
}

/** Creates a new vault configuration. */
export async function* vaultCreate(
  ctx: LibSwampContext,
  deps: VaultCreateDeps,
  input: VaultCreateInput,
): AsyncIterable<VaultCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.create",
    {},
    (async function* () {
      yield { kind: "creating" };

      ctx.logger
        .debug`Creating vault: type=${input.vaultType}, name=${input.name}`;

      // Auto-resolve extension vault types if not already registered
      await deps.resolveExtensionVaultType(input.vaultType);

      // Validate the vault type
      const typeInfo = deps.getVaultTypeInfo(input.vaultType);
      if (!typeInfo) {
        const renamed = RENAMED_VAULT_TYPES[input.vaultType.toLowerCase()];
        if (renamed) {
          yield {
            kind: "error",
            error: validationFailed(
              `The type '${input.vaultType}' has been renamed to '${renamed}'. Use type '${renamed}' instead.`,
            ),
          };
          return;
        }
        const availableTypes = deps.listAvailableTypes().join(", ");
        yield {
          kind: "error",
          error: validationFailed(
            `Unknown vault type: ${input.vaultType}. Available types: ${availableTypes}. Use 'swamp vault type search' to see available types.`,
          ),
        };
        return;
      }

      // Validate vault name format
      if (!/^[a-z][a-z0-9-]*$/.test(input.name)) {
        yield {
          kind: "error",
          error: validationFailed(
            `Invalid vault name: ${input.name}. Vault names must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.`,
          ),
        };
        return;
      }

      // Check name uniqueness
      const exists = await deps.findByName(input.name);
      if (exists) {
        yield {
          kind: "error",
          error: alreadyExists("Vault", input.name),
        };
        return;
      }

      // Resolve provider configuration
      let providerConfig: Record<string, unknown>;

      if (!typeInfo.isBuiltIn && typeInfo.createProvider) {
        // Extension vault type: use provided config, defaulting to {}
        providerConfig = input.config ?? {};

        // Validate against configSchema if provided
        if (typeInfo.configSchema) {
          const result = typeInfo.configSchema.safeParse(providerConfig);
          if (!result.success) {
            yield {
              kind: "error",
              error: validationFailed(
                `Invalid config for vault type '${input.vaultType}': ${result.error.message}`,
              ),
            };
            return;
          }
        }
      } else if (input.config) {
        // Built-in type with explicit config
        providerConfig = input.config;
      } else {
        // Built-in vault type: resolve defaults
        providerConfig = resolveBuiltInProviderConfig(
          input.vaultType,
          input.repoDir,
        );
      }

      // Create and save
      const vaultId = createVaultConfigId(crypto.randomUUID());
      const vaultConfig = VaultConfig.create(
        vaultId,
        input.name,
        input.vaultType,
        providerConfig,
      );
      await deps.save(vaultConfig);

      ctx.logger.debug`Vault created: ${input.name}`;

      const data: VaultCreateData = {
        id: vaultId,
        name: input.name,
        type: input.vaultType,
        typeName: typeInfo.name,
        config: providerConfig,
      };

      yield { kind: "completed", data };
    })(),
  );
}
