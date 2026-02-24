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
  renderVaultGet,
  type VaultGetData,
} from "../../presentation/output/vault_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  SWAMP_DATA_DIR,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultGetCommand = new Command()
  .name("get")
  .description("Show details of a vault configuration")
  .arguments("<vault_name_or_id:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("-t, --type <type:string>", "Vault type (optional, narrows search)")
  .action(async function (options: AnyOptions, vaultNameOrId: string) {
    const ctx = createContext(options as GlobalOptions, ["vault", "get"]);
    ctx.logger.debug`Getting vault: ${vaultNameOrId}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const vaultType = options.type as string | undefined;
    const repo = repoContext.vaultConfigRepo;

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
      storagePath:
        `${SWAMP_DATA_DIR}/${SWAMP_SUBDIRS.vault}/${config.type}/${config.id}.yaml`,
    };

    renderVaultGet(data, ctx.outputMode);
    ctx.logger.debug("Vault get command completed");
  });
