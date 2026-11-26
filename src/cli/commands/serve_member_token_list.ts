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
  memberTokenList,
  type MemberTokenListEvent,
} from "../../libswamp/serve/member_token_list.ts";
import { renderMemberTokenList } from "../../presentation/output/serve_member_output.ts";
import type { FederationTokenListResponse } from "../../serve/protocol.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { openLocalHubForReading } from "./serve_member_local.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveMemberTokenListCommand = withRemoteOptions(
  new Command()
    .name("list")
    .description("List join tokens: state, expiry, and when each was used")
    .example("List join tokens", "swamp serve member token list")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--config <path:string>",
      "Path to the serve config file that makes this repository a hub (default: .swamp/serve.yaml)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "serve",
    "member",
    "token",
    "list",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<FederationTokenListResponse>(
      { server, token },
      { type: "federation.token.list", payload: {} },
    );
    renderMemberTokenList(response, cliCtx.outputMode);
    return;
  }

  const hub = await openLocalHubForReading({
    repoDir: resolveRepoDir(options.repoDir),
    config: options.config as string | undefined,
    outputMode: cliCtx.outputMode,
  });
  await consumeStream(
    memberTokenList(createLibSwampContext({ logger: cliCtx.logger }), {
      admin: hub,
    }),
    withDefaults<MemberTokenListEvent>({
      completed: (event) => {
        renderMemberTokenList(event.data, cliCtx.outputMode);
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );
});
