import { Command } from "@cliffy/command";
import {
  renderVaultSearch,
  toVaultSearchItem,
  type VaultSearchData,
  type VaultSearchItem,
} from "../../presentation/output/vault_search_output.tsx";
import {
  renderVaultDescribe,
} from "../../presentation/output/vault_describe_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { VaultConfig } from "../../domain/vaults/vault_config.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Gets all vaults from the repository as VaultSearchItem array.
 */
async function getAllVaults(
  repo: YamlVaultConfigRepository,
): Promise<VaultSearchItem[]> {
  const configs = await repo.findAll();
  return configs.map(toVaultSearchItem);
}

/**
 * Filters vaults by a query string (case-insensitive match on name, type, or id).
 */
function filterVaults(
  vaults: VaultSearchItem[],
  query: string,
): VaultSearchItem[] {
  if (!query) {
    return vaults;
  }
  const lowerQuery = query.toLowerCase();
  return vaults.filter(
    (v) =>
      v.name.toLowerCase().includes(lowerQuery) ||
      v.type.toLowerCase().includes(lowerQuery) ||
      v.id.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Gets the full vault config for displaying details.
 */
async function getVaultConfig(
  repo: YamlVaultConfigRepository,
  name: string,
): Promise<VaultConfig | null> {
  return await repo.findByName(name);
}

/**
 * Displays the vault describe output for a selected vault.
 */
async function displayVaultDescribe(
  item: VaultSearchItem,
  repo: YamlVaultConfigRepository,
  options: AnyOptions,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["vault", "search"]);
  const config = await getVaultConfig(repo, item.name);

  if (config) {
    renderVaultDescribe(config, ctx.outputMode);
  }
}

export const vaultSearchCommand = new Command()
  .name("search")
  .description("Search for vaults in the repository")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["vault", "search"]);
    ctx.logger.debug`Searching vaults with query: ${query ?? "(none)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repo = repoContext.vaultConfigRepo;
    const allVaults = await getAllVaults(repo);

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredVaults = filterVaults(allVaults, query ?? "");
      const data: VaultSearchData = {
        query: query ?? "",
        results: filteredVaults,
      };
      await renderVaultSearch(data, ctx.outputMode);
    } else {
      // Interactive: show fuzzy search UI
      const data: VaultSearchData = {
        query: query ?? "",
        results: allVaults,
      };

      const selected = await renderVaultSearch(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected vault: ${selected.name}`;
        // Display the vault details
        await displayVaultDescribe(selected, repo, options);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Vault search command completed");
  });
