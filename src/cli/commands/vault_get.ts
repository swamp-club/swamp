import { Command } from "@cliffy/command";
import {
  renderVaultGet,
  type VaultGetData,
} from "../../presentation/output/vault_get_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultGetCommand = new Command()
  .name("get")
  .description("Show details of a vault configuration")
  .arguments("<vault_name_or_id:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-t, --type <type:string>", "Vault type (optional, narrows search)")
  .action(async function (options: AnyOptions, vaultNameOrId: string) {
    const ctx = createContext(options as GlobalOptions, "vault-get");
    ctx.logger.debug`Getting vault: ${vaultNameOrId}`;

    const repoDir = options.repoDir ?? ".";
    const vaultType = options.type as string | undefined;
    const repo = new YamlVaultConfigRepository(repoDir);

    // Look up the vault
    ctx.logger.debug`Looking up vault: ${vaultNameOrId}`;

    // Try to find by name first (works across all types)
    let config = await repo.findByName(vaultNameOrId);

    // If not found by name, try to find by ID
    if (!config) {
      if (vaultType) {
        // If type is specified, look up by type and ID
        config = await repo.findById(vaultType, vaultNameOrId);
      } else {
        // Search all vaults for matching ID
        const allVaults = await repo.findAll();
        config = allVaults.find((v) => v.id === vaultNameOrId) ?? null;
      }
    }

    // If type was specified, verify it matches
    if (config && vaultType && config.type !== vaultType) {
      throw new UserError(
        `Vault '${vaultNameOrId}' found but has type '${config.type}', not '${vaultType}'`,
      );
    }

    if (!config) {
      const typeHint = vaultType ? ` of type '${vaultType}'` : "";
      throw new UserError(`Vault not found: ${vaultNameOrId}${typeHint}`);
    }

    ctx.logger
      .debug`Found vault: id=${config.id}, name=${config.name}, type=${config.type}`;

    const data: VaultGetData = {
      id: config.id,
      name: config.name,
      type: config.type,
      config: config.config,
      createdAt: config.createdAt.toISOString(),
      storagePath: `.swamp/vault/${config.type}/${config.id}.yaml`,
    };

    renderVaultGet(data, ctx.outputMode);
    ctx.logger.debug("Vault get command completed");
  });
