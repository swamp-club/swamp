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
  createVaultDescribeDeps,
  vaultDescribe,
} from "../../libswamp/mod.ts";
import { createVaultDescribeRenderer } from "../../presentation/renderers/vault_describe.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultDescribeCommand = new Command()
  .name("describe")
  .description("Describe a vault configuration")
  .example("Describe a vault", "swamp vault describe my-vault")
  .arguments("<vault_name_or_id:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-t, --type <type:string>", "Vault type (optional, narrows search)")
  .action(async function (options: AnyOptions, vaultNameOrId: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "vault",
      "describe",
    ]);
    cliCtx.logger.debug`Describing vault: ${vaultNameOrId}`;

    const { repoDir } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });
    const vaultType = options.type as string | undefined;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createVaultDescribeDeps(repoDir);

    const renderer = createVaultDescribeRenderer(cliCtx.outputMode);
    await consumeStream(
      vaultDescribe(ctx, deps, vaultNameOrId, vaultType),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Vault describe command completed");
  });
