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
  renderVaultListKeys,
  type VaultListKeysData,
} from "../../presentation/output/vault_list_keys_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultListKeysCommand = new Command()
  .name("list-keys")
  .description("List all secret keys in a vault (without values)")
  .arguments("[vault_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, vaultName?: string) {
    if (!vaultName) {
      throw new UserError(
        "Missing required argument: vault_name\n\n" +
          "Usage: swamp vault list-keys <vault_name>\n\n" +
          "Use 'swamp vault search' to see available vaults.",
      );
    }

    const ctx = createContext(options as GlobalOptions, ["vault", "list-keys"]);
    ctx.logger.debug`Listing secret keys in vault: ${vaultName}`;

    const { repoDir, repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    // Verify vault exists
    const repo = repoContext.vaultConfigRepo;
    const vaultConfig = await repo.findByName(vaultName);
    if (!vaultConfig) {
      // List available vaults for helpful error message
      const allVaults = await repo.findAll();
      if (allVaults.length === 0) {
        throw new UserError(
          `Vault '${vaultName}' not found. No vaults are configured.\n` +
            `Create a vault using: swamp vault create <type> ${vaultName}`,
        );
      }
      const vaultNames = allVaults.map((v) => v.name).join(", ");
      throw new UserError(
        `Vault '${vaultName}' not found. Available vaults: ${vaultNames}`,
      );
    }

    ctx.logger.debug`Found vault: ${vaultConfig.name} (${vaultConfig.type})`;

    // Load vault service to list secrets
    const vaultService = await VaultService.fromRepository(repoDir);

    // List secret keys
    const secretKeys = await vaultService.list(vaultName);
    ctx.logger.debug`Found ${secretKeys.length} secret keys`;

    const data: VaultListKeysData = {
      vaultName,
      vaultType: vaultConfig.type,
      secretKeys,
      count: secretKeys.length,
    };

    renderVaultListKeys(data, ctx.outputMode);
    ctx.logger.debug("Vault list-keys command completed");
  });
