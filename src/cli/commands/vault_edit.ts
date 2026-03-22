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
  consumeStream,
  createLibSwampContext,
  createVaultEditDeps,
  vaultEdit,
} from "../../libswamp/mod.ts";
import {
  renderVaultSearch,
  toVaultSearchItem,
  type VaultSearchData,
  type VaultSearchItem,
} from "../../presentation/output/vault_search_output.tsx";
import { createVaultEditRenderer } from "../../presentation/renderers/vault_edit.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultEditCommand = new Command()
  .name("edit")
  .description("Edit a vault configuration file")
  .arguments("[vault_name_or_id:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-t, --type <type:string>", "Vault type (optional, narrows search)")
  .action(async function (options: AnyOptions, vaultNameOrId?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["vault", "edit"]);
    cliCtx.logger.debug`Editing vault: ${vaultNameOrId ?? "(interactive)"}`;

    const { repoContext, repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const vaultType = options.type as string | undefined;

    // Interactive search mode when no argument provided
    if (!vaultNameOrId) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Vault name or ID is required in non-interactive mode",
        );
      }

      const repo = repoContext.vaultConfigRepo;
      const allVaults = await repo.findAll();

      if (allVaults.length === 0) {
        throw new UserError("No vaults found in repository");
      }

      const searchItems: VaultSearchItem[] = allVaults.map(toVaultSearchItem);
      const searchData: VaultSearchData = {
        query: "",
        results: searchItems,
      };

      const selected = await renderVaultSearch(searchData, cliCtx.outputMode);

      if (!selected) {
        cliCtx.logger.debug`Search cancelled`;
        return;
      }

      cliCtx.logger.debug`Selected vault: ${selected.name} (${selected.id})`;
      vaultNameOrId = selected.name;
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultEditDeps(repoDir);

    const renderer = createVaultEditRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultEdit(ctx, deps, {
        vaultNameOrId,
        vaultType,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault edit command completed");
  });
