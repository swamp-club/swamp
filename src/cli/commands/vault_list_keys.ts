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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createVaultListKeysDeps,
  vaultListKeys,
} from "../../libswamp/mod.ts";
import { createVaultListKeysRenderer } from "../../presentation/renderers/vault_list_keys.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultListKeysCommand = new Command()
  .name("list-keys")
  .description("List all secret keys in a vault (without values)")
  .example("List keys in a vault", "swamp vault list-keys my-vault")
  .example("List all vault keys", "swamp vault list-keys")
  .arguments("[vault_name:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, vaultName?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "vault",
      "list-keys",
    ]);
    cliCtx.logger.debug`Listing secret keys in vault: ${vaultName}`;

    const { repoDir } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createVaultListKeysDeps(repoDir);

    const renderer = createVaultListKeysRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultListKeys(ctx, deps, { vaultName: vaultName ?? "" }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault list-keys command completed");
  });
