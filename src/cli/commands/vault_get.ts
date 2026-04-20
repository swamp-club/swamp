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
  createVaultGetDeps,
  vaultGet,
} from "../../libswamp/mod.ts";
import { createVaultGetRenderer } from "../../presentation/renderers/vault_get.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultGetCommand = new Command()
  .name("get")
  .description("Show details of a vault configuration")
  .example("Show vault details", "swamp vault get my-vault")
  .arguments("<vault_name_or_id:string> [extra:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-t, --type <type:string>", "Vault type (optional, narrows search)")
  .action(
    async function (
      options: AnyOptions,
      vaultNameOrId: string,
      extra?: string,
    ) {
      if (extra) {
        throw new UserError(
          `Unexpected argument: ${extra}\n\n` +
            "Usage: swamp vault get <vault_name_or_id>\n\n" +
            "To retrieve a secret value, use: swamp vault list-keys <vault_name>",
        );
      }

      const cliCtx = createContext(options as GlobalOptions, ["vault", "get"]);
      cliCtx.logger.debug`Getting vault: ${vaultNameOrId}`;

      const { repoDir } = await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });
      const vaultType = options.type as string | undefined;

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createVaultGetDeps(repoDir);

      const renderer = createVaultGetRenderer(cliCtx.outputMode);
      await consumeStream(
        vaultGet(ctx, deps, vaultNameOrId, vaultType),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Vault get command completed");
    },
  );
