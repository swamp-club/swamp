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
  memberGet,
  type MemberGetEvent,
} from "../../libswamp/serve/member_get.ts";
import { renderMemberGet } from "../../presentation/output/serve_member_output.ts";
import type { FederationMemberGetResponse } from "../../serve/protocol.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { openLocalHubForReading } from "./serve_member_local.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveMemberGetCommand = withRemoteOptions(
  new Command()
    .name("get")
    .description(
      "Show one member: its status, fingerprint and the instances checking in",
    )
    .example("Show the member edge-1", "swamp serve member get edge-1")
    .arguments("<name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--config <path:string>",
      "Path to the serve config file that makes this repository a hub (default: .swamp/serve.yaml)",
    ),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "serve",
    "member",
    "get",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<FederationMemberGetResponse>(
      { server, token },
      { type: "federation.member.get", payload: { name } },
    );
    renderMemberGet(response, cliCtx.outputMode);
    return;
  }

  const hub = await openLocalHubForReading({
    repoDir: resolveRepoDir(options.repoDir),
    config: options.config as string | undefined,
    outputMode: cliCtx.outputMode,
  });
  await consumeStream(
    memberGet(createLibSwampContext({ logger: cliCtx.logger }), {
      admin: hub,
    }, { name }),
    withDefaults<MemberGetEvent>({
      completed: (event) => {
        renderMemberGet(event.data, cliCtx.outputMode);
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );
});
