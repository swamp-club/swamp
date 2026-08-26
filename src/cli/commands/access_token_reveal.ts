// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  consumeStream,
  createLibSwampContext,
  createServerTokenRevealDeps,
  serverTokenReveal,
  type ServerTokenRevealData,
  type ServerTokenRevealEvent,
  withDefaults,
} from "../../libswamp/mod.ts";
import { renderServerTokenReveal } from "../../presentation/output/access_token_output.ts";
import { initializeControlPlaneVaultForCli } from "../control_plane_vault.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const accessTokenRevealCommand = new Command()
  .name("reveal")
  .description(
    "Show the full authentication credential for a server token",
  )
  .example(
    "Reveal a token (interactive confirmation)",
    "swamp access token reveal adam-token",
  )
  .example(
    "Reveal a token (skip confirmation)",
    "swamp access token reveal adam-token --yes",
  )
  .arguments("<name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "-y, --yes",
    "Skip confirmation prompt",
  )
  .option(
    "-f, --force",
    "Skip confirmation prompt (alias for --yes)",
  )
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "access",
      "token",
      "reveal",
    ]);

    const { repoDir, repoContext, syncService } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    await initializeControlPlaneVaultForCli(repoDir, syncService);

    const vaultService = await VaultService.fromRepository(repoDir);
    const deps = createServerTokenRevealDeps(
      repoContext.dataQueryService,
      vaultService,
    );

    const skipConfirm = !!(options.yes || options.force);
    if (cliCtx.outputMode === "log" && !skipConfirm) {
      const confirmed = await promptConfirmation(
        `This will reveal the secret for token '${name}'. Continue?`,
      );
      if (!confirmed) {
        writeOutput("Reveal cancelled.");
        return;
      }
    }

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    let data: ServerTokenRevealData | undefined;
    await consumeStream(
      serverTokenReveal(libCtx, deps, name),
      withDefaults<ServerTokenRevealEvent>({
        completed: (event) => {
          data = event.data;
        },
        error: (event) => {
          throw new UserError(event.error.message);
        },
      }),
    );
    if (data === undefined) {
      throw new UserError(
        `Revealing token '${name}' ended without completing`,
      );
    }

    renderServerTokenReveal(data, cliCtx.outputMode);

    cliCtx.logger.debug("Server token reveal command completed");
  });
