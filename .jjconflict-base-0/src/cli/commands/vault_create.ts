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
import { UserError } from "../../domain/errors.ts";
import {
  createVaultConfigId,
  VaultConfig,
} from "../../domain/vaults/vault_config.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

interface VaultCreateOptions {
  region?: string;
  vaultUrl?: string;
  opVault?: string;
  opAccount?: string;
}

/**
 * Resolves provider-specific configuration for each vault type.
 * Provider options (e.g., region, vault URL) are resolved at creation time
 * from flags or environment variables and persisted in the config file.
 */
function resolveProviderConfig(
  vaultType: string,
  repoDir: string,
  options: VaultCreateOptions,
  logger: {
    info: (template: TemplateStringsArray, ...args: unknown[]) => void;
  },
): Record<string, unknown> {
  switch (vaultType) {
    case "aws-sm": {
      const region = options.region || Deno.env.get("AWS_REGION");
      if (!region) {
        throw new UserError(
          "AWS region is required. Provide --region or set AWS_REGION environment variable.",
        );
      }
      if (!options.region) {
        logger
          .info`Using region from AWS_REGION environment variable: ${region}`;
      }
      return { region };
    }
    case "azure-kv": {
      const vaultUrl = options.vaultUrl || Deno.env.get("AZURE_KEYVAULT_URL");
      if (!vaultUrl) {
        throw new UserError(
          "Azure Key Vault URL is required. Provide --vault-url or set AZURE_KEYVAULT_URL environment variable.",
        );
      }
      if (!options.vaultUrl) {
        logger
          .info`Using vault URL from AZURE_KEYVAULT_URL environment variable: ${vaultUrl}`;
      }
      return { vault_url: vaultUrl };
    }
    case "1password": {
      const opVault = options.opVault || Deno.env.get("OP_VAULT");
      if (!opVault) {
        throw new UserError(
          "1Password vault name is required. Provide --op-vault or set OP_VAULT environment variable.",
        );
      }
      if (!options.opVault) {
        logger
          .info`Using vault name from OP_VAULT environment variable: ${opVault}`;
      }
      const opAccount = options.opAccount || Deno.env.get("OP_ACCOUNT");
      if (opAccount && !options.opAccount) {
        logger
          .info`Using account from OP_ACCOUNT environment variable: ${opAccount}`;
      }
      const config: Record<string, unknown> = { op_vault: opVault };
      if (opAccount) {
        config.op_account = opAccount;
      }
      return config;
    }
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
    "--region <region:string>",
    "AWS region (for aws-sm type). Falls back to AWS_REGION env var.",
  )
  .option(
    "--vault-url <url:string>",
    "Azure Key Vault URL (for azure-kv type). Falls back to AZURE_KEYVAULT_URL env var.",
  )
  .option(
    "--op-vault <vault:string>",
    "1Password vault name (for 1password type). Falls back to OP_VAULT env var.",
  )
  .option(
    "--op-account <account:string>",
    "1Password account shorthand (for 1password type). Falls back to OP_ACCOUNT env var.",
  )
  .option(
    "--config <json:string>",
    "Provider configuration as JSON (for user-defined vault types)",
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

      // Validate the vault type using the registry
      const typeInfo = vaultTypeRegistry.get(vaultType);
      if (!typeInfo) {
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
        // User-defined vault type: parse --config JSON
        if (!options.config) {
          throw new UserError(
            `User-defined vault type '${vaultType}' requires --config <json> with provider configuration.`,
          );
        }

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

        // Validate against configSchema if provided
        if (typeInfo.configSchema) {
          const result = typeInfo.configSchema.safeParse(providerConfig);
          if (!result.success) {
            throw new UserError(
              `Invalid config for vault type '${vaultType}': ${result.error.message}`,
            );
          }
        }
      } else {
        // Built-in vault type: resolve from flags/env vars
        providerConfig = resolveProviderConfig(
          vaultType,
          repoDir,
          {
            region: options.region,
            vaultUrl: options.vaultUrl,
            opVault: options.opVault,
            opAccount: options.opAccount,
          },
          ctx.logger,
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
