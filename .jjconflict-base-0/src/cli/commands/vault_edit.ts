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
  renderVaultEdit,
  type VaultEditData,
} from "../../presentation/output/vault_edit_output.ts";
import {
  renderVaultSearch,
  toVaultSearchItem,
  type VaultSearchData,
  type VaultSearchItem,
} from "../../presentation/output/vault_search_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";
import type { VaultConfig } from "../../domain/vaults/vault_config.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Gets the file path for a vault configuration.
 */
function getVaultPath(repoDir: string, config: VaultConfig): string {
  return swampPath(
    repoDir,
    SWAMP_SUBDIRS.vault,
    config.type,
    `${config.id}.yaml`,
  );
}

export const vaultEditCommand = new Command()
  .name("edit")
  .description("Edit a vault configuration file")
  .arguments("[vault_name_or_id:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-t, --type <type:string>", "Vault type (optional, narrows search)")
  .action(async function (options: AnyOptions, vaultNameOrId?: string) {
    const ctx = createContext(options as GlobalOptions, ["vault", "edit"]);
    ctx.logger.debug`Editing vault: ${vaultNameOrId ?? "(interactive)"}`;

    const { repoDir, repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const vaultType = options.type as string | undefined;
    const repo = repoContext.vaultConfigRepo;
    const editorService = new EditorService();

    let config: VaultConfig | null = null;

    if (!vaultNameOrId) {
      // No argument provided - check if interactive mode
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Vault name or ID is required in non-interactive mode",
        );
      }

      // Show search UI to select a vault
      const allVaults = await repo.findAll();

      if (allVaults.length === 0) {
        throw new UserError("No vaults found in repository");
      }

      const searchItems: VaultSearchItem[] = allVaults.map(toVaultSearchItem);
      const searchData: VaultSearchData = {
        query: "",
        results: searchItems,
      };

      const selected = await renderVaultSearch(searchData, ctx.outputMode);

      if (!selected) {
        ctx.logger.debug`Search cancelled`;
        return;
      }

      ctx.logger.debug`Selected vault: ${selected.name} (${selected.id})`;

      // Find the full vault config
      config = await repo.findByName(selected.name);
      if (!config) {
        throw new UserError(`Vault not found: ${selected.name}`);
      }
    } else {
      // Look up the vault by name or ID
      ctx.logger.debug`Looking up vault: ${vaultNameOrId}`;

      // Try to find by name first
      config = await repo.findByName(vaultNameOrId);

      // If not found by name, try to find by ID
      if (!config) {
        if (vaultType) {
          config = await repo.findById(vaultType, vaultNameOrId);
        } else {
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
    }

    ctx.logger
      .debug`Found vault: id=${config.id}, name=${config.name}, type=${config.type}`;

    // Get the file path
    const filePath = getVaultPath(repoDir, config);

    // Check if file exists
    try {
      await Deno.stat(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new UserError(
          `Vault configuration file not found at: ${filePath}`,
        );
      }
      throw error;
    }

    ctx.logger.debug`Opening file: ${filePath}`;

    // Open the editor
    const result = await editorService.openFile(filePath);

    const data: VaultEditData = {
      path: filePath,
      editor: result.editor,
      status: "opened",
      name: config.name,
      type: config.type,
    };

    renderVaultEdit(data, ctx.outputMode);
    ctx.logger.debug("Vault edit command completed");
  });
