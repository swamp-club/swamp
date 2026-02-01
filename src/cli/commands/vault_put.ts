import { Command } from "@cliffy/command";
import {
  renderVaultPut,
  renderVaultPutCancelled,
  type VaultPutData,
} from "../../presentation/output/vault_put_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { createVaultSecretUpdated } from "../../domain/events/types.ts";

/**
 * Prompts user for confirmation in interactive mode.
 * Uses basic stdin reading for confirmation prompt.
 */
async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    return false;
  }

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

/**
 * Parses a KEY=VALUE string into key and value parts.
 * Handles values that contain = signs.
 */
function parseKeyValue(input: string): { key: string; value: string } | null {
  const equalsIndex = input.indexOf("=");
  if (equalsIndex === -1) {
    return null;
  }

  const key = input.substring(0, equalsIndex);
  const value = input.substring(equalsIndex + 1);

  if (key.length === 0) {
    return null;
  }

  return { key, value };
}

/**
 * Checks if a secret exists in the vault by attempting to get it.
 */
async function secretExists(
  vaultService: VaultService,
  vaultName: string,
  secretKey: string,
): Promise<boolean> {
  try {
    await vaultService.get(vaultName, secretKey);
    return true;
  } catch {
    // Secret doesn't exist or error retrieving it
    return false;
  }
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultPutCommand = new Command()
  .name("put")
  .description("Store a secret in a vault")
  .arguments("<vault_name:string> <key_value:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-f, --force", "Skip confirmation prompt when overwriting")
  .action(async function (
    options: AnyOptions,
    vaultName: string,
    keyValue: string,
  ) {
    const ctx = createContext(options as GlobalOptions, "vault-put");
    ctx.logger.debug`Storing secret in vault: ${vaultName}`;

    const repoDir = options.repoDir ?? ".";

    // Parse KEY=VALUE argument
    const parsed = parseKeyValue(keyValue);
    if (!parsed) {
      throw new UserError(
        `Invalid argument format. Expected KEY=VALUE, got: ${keyValue}`,
      );
    }

    const { key, value } = parsed;
    ctx.logger.debug`Parsed key: ${key}`;

    // Load vault service to interact with secrets
    // This loads vaults from both .data/vault/ and .swamp.yaml
    const vaultService = await VaultService.fromRepository(repoDir);

    // Verify vault exists by checking if VaultService knows about it
    const availableVaults = vaultService.getVaultNames();
    if (!availableVaults.includes(vaultName)) {
      if (availableVaults.length === 0) {
        throw new UserError(
          `Vault '${vaultName}' not found. No vaults are configured.\n` +
            `Create a vault using: swamp vault create <type> ${vaultName}\n` +
            `Or configure a vault in .swamp.yaml`,
        );
      }
      throw new UserError(
        `Vault '${vaultName}' not found. Available vaults: ${
          availableVaults.join(", ")
        }`,
      );
    }

    // Get vault config for display purposes (from .data/vault/ if available)
    const repo = new YamlVaultConfigRepository(repoDir);
    const vaultConfig = await repo.findByName(vaultName);
    // If not in .data/vault/, the vault is from .swamp.yaml - we'll report the type as "configured"
    const vaultType = vaultConfig?.type ?? "configured";

    ctx.logger.debug`Found vault: ${vaultName} (${vaultType})`;

    // Check if secret already exists
    const exists = await secretExists(vaultService, vaultName, key);
    ctx.logger.debug`Secret exists: ${exists}`;

    // Prompt for confirmation if overwriting in interactive mode
    if (exists && ctx.outputMode === "interactive" && !options.force) {
      const confirmed = await promptConfirmation(
        `Secret '${key}' already exists in vault '${vaultName}'. Overwrite?`,
      );
      if (!confirmed) {
        renderVaultPutCancelled(ctx.outputMode);
        return;
      }
    }

    // Store the secret
    await vaultService.put(vaultName, key, value);
    ctx.logger.debug`Secret stored successfully`;

    // Emit event to update the logical view symlinks (only if vault is from .data/vault/)
    if (vaultConfig) {
      const repoContext = createRepositoryContext({ repoDir });
      const event = createVaultSecretUpdated(
        vaultConfig.id,
        vaultConfig.type,
        vaultConfig.name,
        key,
      );
      await repoContext.eventBus.publish(event);
      ctx.logger.debug`Emitted VaultSecretUpdated event`;
    }

    const data: VaultPutData = {
      vaultName,
      secretKey: key,
      vaultType,
      overwritten: exists,
      timestamp: new Date().toISOString(),
    };

    renderVaultPut(data, ctx.outputMode);
    ctx.logger.debug("Vault put command completed");
  });
