import { Command } from "@cliffy/command";
import {
  renderVaultCreate,
  type VaultCreateData,
} from "../../presentation/output/vault_create_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { getVaultType } from "../../domain/vaults/vault_types.ts";
import { UserError } from "../../domain/errors.ts";
import {
  createVaultConfigId,
  VaultConfig,
} from "../../domain/vaults/vault_config.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Default configuration for each vault type.
 */
function getDefaultConfig(
  vaultType: string,
  repoDir: string,
  _vaultName: string,
): Record<string, unknown> {
  switch (vaultType) {
    case "aws":
      return {
        region: "us-east-1",
      };
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

      // Validate the vault type
      const typeInfo = getVaultType(vaultType);
      if (!typeInfo) {
        throw new UserError(
          `Unknown vault type: ${vaultType}. Use 'swamp vault type search' to see available types.`,
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

      // Create the vault config
      const defaultConfig = getDefaultConfig(vaultType, repoDir, vaultName);
      const vaultId = createVaultConfigId(generateVaultId());
      const vaultConfig = VaultConfig.create(
        vaultId,
        vaultName,
        vaultType,
        defaultConfig,
      );

      // Save to repository
      await repo.save(vaultConfig);

      ctx.logger.debug`Vault created: ${vaultName}`;

      const data: VaultCreateData = {
        id: vaultId,
        name: vaultName,
        type: vaultType,
        typeName: typeInfo.name,
        config: defaultConfig,
      };

      renderVaultCreate(data, ctx.outputMode);
      ctx.logger.debug("Vault create command completed");
    },
  );
