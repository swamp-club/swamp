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
import { MAX_JOIN_TOKEN_DURATION_MS } from "../../domain/serve/join_token.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { parseDuration } from "../../libswamp/data/search.ts";
import {
  memberTokenCreate,
  type MemberTokenCreateEvent,
} from "../../libswamp/serve/member_token_create.ts";
import { renderMemberTokenCreate } from "../../presentation/output/serve_member_output.ts";
import type { FederationTokenCreateResponse } from "../../serve/protocol.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { openLocalHubForTokens } from "./serve_member_local.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveMemberTokenCreateCommand = withRemoteOptions(
  new Command()
    .name("create")
    .description(
      "Mint a single-use join token for a member serve; the plaintext is shown once",
    )
    .example(
      "Mint a token for a member named edge-1",
      "swamp serve member token create edge-1",
    )
    .example(
      "Mint a token on a running hub that lasts a day",
      "swamp serve member token create edge-1 --duration 24h --server wss://hub.example.com",
    )
    .arguments("<name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--config <path:string>",
      "Path to the serve config file that makes this repository a hub (default: .swamp/serve.yaml)",
    )
    .option(
      "--duration <duration:string>",
      "How long the token can be used to join (e.g. 30m, 1h, 7d; at most 30d)",
      { default: "1h" },
    ),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "serve",
    "member",
    "token",
    "create",
  ]);
  const durationMs = parseDuration(options.duration as string);
  if (durationMs <= 0 || durationMs > MAX_JOIN_TOKEN_DURATION_MS) {
    throw new UserError(
      `Invalid --duration value "${options.duration}": must be positive and at most 30d`,
    );
  }

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<
      FederationTokenCreateResponse
    >(
      { server, token },
      { type: "federation.token.create", payload: { name, durationMs } },
    );
    renderMemberTokenCreate(response, cliCtx.outputMode);
    return;
  }

  const hub = await openLocalHubForTokens({
    repoDir: resolveRepoDir(options.repoDir),
    config: options.config as string | undefined,
    outputMode: cliCtx.outputMode,
  });
  await consumeStream(
    memberTokenCreate(createLibSwampContext({ logger: cliCtx.logger }), {
      admin: hub,
    }, { name, durationMs }),
    withDefaults<MemberTokenCreateEvent>({
      completed: (event) => {
        renderMemberTokenCreate(event.data, cliCtx.outputMode);
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );
});
