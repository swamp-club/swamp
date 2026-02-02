import { Command } from "@cliffy/command";
import {
  renderVaultListKeys,
  type VaultListKeysData,
} from "../../presentation/output/vault_list_keys_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultListKeysCommand = new Command()
  .name("list-keys")
  .description("List all secret keys in a vault (without values)")
  .arguments("<vault_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, vaultName: string) {
    const ctx = createContext(options as GlobalOptions, "vault-list-keys");
    ctx.logger.debug`Listing secret keys in vault: ${vaultName}`;

    const repoDir = options.repoDir ?? ".";

    // Load vault service (loads from both .data/vault/ and .swamp.yaml)
    const vaultService = await VaultService.fromRepository(repoDir);

    // Verify vault exists
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

    // Get vault type for display (from .data/vault/ if available)
    const repo = new YamlVaultConfigRepository(repoDir);
    const vaultConfig = await repo.findByName(vaultName);
    const vaultType = vaultConfig?.type ?? "configured";

    ctx.logger.debug`Found vault: ${vaultName} (${vaultType})`;

    // List secret keys
    const secretKeys = await vaultService.list(vaultName);
    ctx.logger.debug`Found ${secretKeys.length} secret keys`;

    const data: VaultListKeysData = {
      vaultName,
      vaultType,
      secretKeys,
      count: secretKeys.length,
    };

    renderVaultListKeys(data, ctx.outputMode);
    ctx.logger.debug("Vault list-keys command completed");
  });
