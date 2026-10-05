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
import {
  findNonDefaultKeySourceFields,
  isLocalEncryptionType,
  withServerDefaultKeySource,
} from "../../domain/vaults/local_encryption_key_source.ts";
import {
  isValidVaultName,
  VAULT_NAME_RULE,
} from "../../domain/vaults/vault_name.ts";
import { resolveVaultType } from "../../domain/extensions/extension_auto_resolver.ts";
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
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
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
  auditReads?: boolean;
  /**
   * Accept a local_encryption config that names its own key source (key
   * file, SSH key, storage directory). Only a caller that already owns the
   * host sets this: the local CLI. Without it, such fields are refused
   * unless they match the server defaults, which are always applied
   * (swamp-club#2690).
   */
  trustKeySource?: boolean;
}

/** Dependencies for the vault create operation. */
export interface VaultCreateDeps {
  /** Loads a lazily-indexed type if needed and says whether it is known. */
  isVaultTypeLoaded: (type: string) => Promise<boolean>;
  /**
   * The config fields the registry publishes for an extension type that is
   * not installed yet, so the CLI can ask for the missing ones before the
   * install (swamp-club#3003).
   */
  findRegistryConfigFields: RegistryConfigFieldsLookup;
  resolveExtensionVaultType: (type: string) => Promise<void>;
  getVaultTypeInfo: (type: string) => VaultTypeInfo | undefined;
  findByName: (name: string) => Promise<boolean>;
  save: (config: VaultConfig) => Promise<void>;
  listAvailableTypes: () => string[];
}

/**
 * Wires real infrastructure into VaultCreateDeps. Serve injects its shared
 * repository, whose mark hook signals the saved config.
 */
export async function createVaultCreateDeps(
  repoDir: string,
  injectedRepo?: YamlVaultConfigRepository,
): Promise<VaultCreateDeps> {
  await vaultTypeRegistry.ensureLoaded();
  const repo = injectedRepo ?? new YamlVaultConfigRepository(repoDir);
  return {
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
  if (isLocalEncryptionType(vaultType)) {
    return {
      auto_generate: true,
      base_dir: repoDir,
    };
  }
  return {};
}

/** How to try the creation again once the config is complete. */
function createRerunHint(vaultType: string, name: string): RerunHint {
  return (example, missing) =>
    missing.length > 0
      ? `Re-run with: swamp vault create ${vaultType} ${name} --config ${
        shellSingleQuote(example)
      }`
      : "Re-run with a corrected --config.";
}

/** Creates a new vault configuration. */
export async function* vaultCreate(
  ctx: LibSwampContext,
  deps: VaultCreateDeps,
  input: VaultCreateInput,
): AsyncIterable<VaultCreateEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.vault.create",
      {},
      (async function* () {
        yield { kind: "creating" };

        ctx.logger
          .debug`Creating vault: type=${input.vaultType}, name=${input.name}`;

        const rerunHint = createRerunHint(input.vaultType, input.name);

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
        if (!isValidVaultName(input.name)) {
          yield {
            kind: "error",
            error: validationFailed(
              `Invalid vault name: ${input.name}. ${VAULT_NAME_RULE}`,
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
                  explainVaultConfigIssues({
                    vaultType: input.vaultType,
                    config: providerConfig,
                    issues: result.error.issues,
                    fields: describeVaultConfigFields(typeInfo.configSchema),
                    rerunHint,
                  }),
                ),
              };
              return;
            }
          }
        } else if (
          input.config && !input.trustKeySource &&
          isLocalEncryptionType(input.vaultType)
        ) {
          // The key source names files on this host, so a caller that does not
          // own it gets the server defaults.
          const refused = findNonDefaultKeySourceFields(
            input.config,
            input.repoDir,
          );
          if (refused.length > 0) {
            yield {
              kind: "error",
              error: validationFailed(
                `Cannot set ${refused.join(", ")} for vault '${input.name}': ` +
                  `a local_encryption vault created remotely uses the server's ` +
                  `key source. Leave these fields out, or run the command on the host running swamp.`,
              ),
            };
            return;
          }
          providerConfig = withServerDefaultKeySource(
            input.config,
            input.repoDir,
          );
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
          input.auditReads,
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
    ));
}
