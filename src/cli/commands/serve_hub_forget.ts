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
import { UserError } from "../../domain/errors.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  hubForget,
  type HubForgetEvent,
} from "../../libswamp/serve/hub_forget.ts";
import { renderHubForget } from "../../presentation/output/serve_hub_output.ts";
import { openLocalHubLinkForForget } from "./serve_hub_local.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveHubForgetCommand = new Command()
  .name("forget")
  .description("Forget this serve's hub link and member credential")
  .example(
    "Forget the hub link (stop serve first: forget is refused while it runs)",
    "swamp serve hub forget --yes",
  )
  .option("-y, --yes", "Skip the confirmation prompt")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--config <path:string>",
    "Path to the serve config file that makes this repository a member (default: .swamp/serve.yaml)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "serve",
      "hub",
      "forget",
    ]);
    if (options.yes !== true) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Forgetting the hub link deletes this serve's member credential; pass --yes to confirm",
        );
      }
      const confirmed = await promptConfirmation(
        "Forget this serve's hub link and delete its member credential? It can only join a hub again with a new join token.",
      );
      if (!confirmed) {
        writeOutput("Cancelled.");
        return;
      }
    }
    const deps = await openLocalHubLinkForForget({
      repoDir: resolveRepoDir(options.repoDir),
      config: options.config as string | undefined,
      outputMode: cliCtx.outputMode,
      forget: true,
    });
    await consumeStream(
      hubForget(createLibSwampContext({ logger: cliCtx.logger }), deps),
      withDefaults<HubForgetEvent>({
        completed: (event) => {
          renderHubForget(event.data, cliCtx.outputMode);
        },
        error: (event) => {
          throw new UserError(event.error.message, event.error.code);
        },
      }),
    );
  });
