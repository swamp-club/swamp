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

import { Command } from "@cliffy/command";
import {
  renderVaultCreate,
  type VaultCreateData,
} from "../../presentation/output/vault_create_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { resolveVaultType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createVaultConfigId,
  VaultConfig,
} from "../../domain/vaults/vault_config.ts";
import { RENAMED_VAULT_TYPES } from "../../domain/vaults/vault_service.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Resolves provider-specific configuration for built-in vault types.
 */
function resolveProviderConfig(
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

/**
 * Prompts user for vault name in interactive mode.
 */
async function promptVaultName(): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode("Enter vault name: "));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    throw new UserError("No input provided for vault name.");
  }

  return decoder.decode(buf.subarray(0, n)).trim();
}

/**
 * Generates a unique ID for a vault config.
 */
function generateVaultId(): string {
  return crypto.randomUUID();
}

export const vaultCreateCommand = new Command()
  .name("create")
  .description("Create a new vault configuration")
  .arguments("<type:string> [name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--config <json:string>",
    "Provider configuration as JSON",
  )
  .action(
    async function (
      options: AnyOptions,
      vaultType: string,
      vaultNameArg?: string,
    ) {
      const ctx = createContext(options as GlobalOptions, ["vault", "create"]);
      const { repoDir, repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });

      // Get vault name - prompt if not provided
      let vaultName = vaultNameArg;
      if (!vaultName) {
        if (ctx.outputMode === "json") {
          throw new UserError(
            "Vault name is required in non-interactive mode. Usage: swamp vault create <type> <name>",
          );
        }
        vaultName = await promptVaultName();
        if (!vaultName) {
          throw new UserError("Vault name is required.");
        }
      }

      ctx.logger
        .debug`Creating vault: type=${vaultType}, name=${vaultName}`;

      // Auto-resolve extension vault types if not already installed
      if (!vaultTypeRegistry.has(vaultType) && vaultType.startsWith("@")) {
        await resolveVaultType(vaultType, getAutoResolver());
      }

      // Validate the vault type using the registry
      const typeInfo = vaultTypeRegistry.get(vaultType);
      if (!typeInfo) {
        const renamed = RENAMED_VAULT_TYPES[vaultType.toLowerCase()];
        if (renamed) {
          throw new UserError(
            `The type '${vaultType}' has been renamed to '${renamed}'. Use: swamp vault create ${renamed} ${vaultName}`,
          );
        }
        const availableTypes = vaultTypeRegistry.getAll().map((v) => v.type)
          .join(", ");
        throw new UserError(
          `Unknown vault type: ${vaultType}. Available types: ${availableTypes}. Use 'swamp vault type search' to see available types.`,
        );
      }

      // Validate vault name
      if (!/^[a-z][a-z0-9-]*$/.test(vaultName)) {
        throw new UserError(
          `Invalid vault name: ${vaultName}. Vault names must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.`,
        );
      }

      const repo = repoContext.vaultConfigRepo;

      const existingVault = await repo.findByName(vaultName);
      if (existingVault) {
        throw new UserError(
          `Vault '${vaultName}' already exists. Use a different name or remove the existing vault configuration.`,
        );
      }

      // Resolve provider configuration
      let providerConfig: Record<string, unknown>;

      if (!typeInfo.isBuiltIn && typeInfo.createProvider) {
        // Extension vault type: parse --config JSON, defaulting to {} if not provided
        if (options.config) {
          try {
            providerConfig = JSON.parse(options.config) as Record<
              string,
              unknown
            >;
          } catch {
            throw new UserError(
              `Invalid JSON in --config: ${options.config}`,
            );
          }
        } else {
          providerConfig = {};
        }

        // Validate against configSchema if provided
        if (typeInfo.configSchema) {
          const result = typeInfo.configSchema.safeParse(providerConfig);
          if (!result.success) {
            throw new UserError(
              `Invalid config for vault type '${vaultType}': ${result.error.message}`,
            );
          }
        }
      } else if (options.config) {
        // Built-in type with explicit --config JSON
        try {
          providerConfig = JSON.parse(options.config) as Record<
            string,
            unknown
          >;
        } catch {
          throw new UserError(
            `Invalid JSON in --config: ${options.config}`,
          );
        }
      } else {
        // Built-in vault type: resolve defaults
        providerConfig = resolveProviderConfig(
          vaultType,
          repoDir,
        );
      }

      const vaultId = createVaultConfigId(generateVaultId());
      const vaultConfig = VaultConfig.create(
        vaultId,
        vaultName,
        vaultType,
        providerConfig,
      );

      // Save to repository
      await repo.save(vaultConfig);

      ctx.logger.debug`Vault created: ${vaultName}`;

      const data: VaultCreateData = {
        id: vaultId,
        name: vaultName,
        type: vaultType,
        typeName: typeInfo.name,
        config: providerConfig,
      };

      renderVaultCreate(data, ctx.outputMode);
      ctx.logger.debug("Vault create command completed");
    },
  );
