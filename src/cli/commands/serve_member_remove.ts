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
  memberRemove,
  type MemberRemoveEvent,
} from "../../libswamp/serve/member_remove.ts";
import { renderMemberRemove } from "../../presentation/output/serve_member_output.ts";
import type { FederationMemberResponse } from "../../serve/protocol.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { withLocalHubForMember } from "./serve_member_local.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveMemberRemoveCommand = withRemoteOptions(
  new Command()
    .name("remove")
    .description(
      "Remove a member: its credential stops checking in and its record is marked removed",
    )
    .example("Remove the member edge-1", "swamp serve member remove edge-1")
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
    "remove",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<FederationMemberResponse>(
      { server, token },
      { type: "federation.member.remove", payload: { name } },
    );
    renderMemberRemove(response, cliCtx.outputMode);
    return;
  }

  await withLocalHubForMember(
    {
      repoDir: resolveRepoDir(options.repoDir),
      config: options.config as string | undefined,
      outputMode: cliCtx.outputMode,
    },
    name,
    async (hub) => {
      await consumeStream(
        memberRemove(createLibSwampContext({ logger: cliCtx.logger }), {
          admin: hub,
        }, { name }),
        withDefaults<MemberRemoveEvent>({
          completed: (event) => {
            renderMemberRemove(event.data, cliCtx.outputMode);
          },
          error: (event) => {
            throw new UserError(event.error.message);
          },
        }),
      );
    },
  );
});
