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
  hubLinkGet,
  type HubLinkGetEvent,
} from "../../libswamp/serve/hub_link_get.ts";
import { renderHubLink } from "../../presentation/output/serve_hub_output.ts";
import type { FederationLinkGetResponse } from "../../serve/protocol.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { serveHubForgetCommand } from "./serve_hub_forget.ts";
import { openLocalHubLink } from "./serve_hub_local.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveHubCommand = withRemoteOptions(
  new Command()
    .name("hub")
    .description(
      "Show this member serve's link to its federation hub and each instance's last check-in",
    )
    .example("Show the hub link", "swamp serve hub")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--config <path:string>",
      "Path to the serve config file that makes this repository a member (default: .swamp/serve.yaml)",
    ),
)
  .error(unknownCommandErrorHandler)
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["serve", "hub"]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(server, options);
      const response = await requestServerResponse<FederationLinkGetResponse>(
        { server, token },
        { type: "federation.link.get", payload: {} },
      );
      renderHubLink(response, cliCtx.outputMode);
      return;
    }

    const member = await openLocalHubLink({
      repoDir: resolveRepoDir(options.repoDir),
      config: options.config as string | undefined,
      outputMode: cliCtx.outputMode,
    });
    await consumeStream(
      hubLinkGet(createLibSwampContext({ logger: cliCtx.logger }), {
        links: member.links,
        configuredHubUrl: member.configuredHubUrl,
      }),
      withDefaults<HubLinkGetEvent>({
        completed: (event) => {
          renderHubLink({ link: event.data }, cliCtx.outputMode);
        },
        error: (event) => {
          throw new UserError(event.error.message, event.error.code);
        },
      }),
    );
  })
  .command("forget", serveHubForgetCommand);
