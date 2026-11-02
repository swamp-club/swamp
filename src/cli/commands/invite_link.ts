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
import { createContext, type GlobalOptions } from "../context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { inviteLink, type InviteLinkDeps } from "../../libswamp/invite/link.ts";
import { createInviteLinkRenderer } from "../../presentation/renderers/invite_link.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * built twice, as invite link and as hidden top-level first-rule: an alias
 * would show in help, and an easter egg listed in help is not one. Both names
 * are listed in stdout_contract.ts; renaming either means updating that list.
 */
function buildInviteLinkCommand(name: string, path: string[]): Command {
  const invocation = ["swamp", ...path].join(" ");
  return new Command()
    .name(name)
    .description("Print your swamp-club invite link")
    .example("Print your invite link", invocation)
    .example("Capture the link for a script", `${invocation} --json`)
    .action(async function (options: AnyOptions) {
      const ctx = createContext(options as GlobalOptions, path);

      const credentials = await new AuthRepository().load();
      // there is no anonymous form of this endpoint (the link is
      // identity-scoped): fail before the round trip, naming both credential
      // sources so CI is not sent to an interactive login.
      if (!credentials?.apiKey) {
        throw new UserError(
          'Not logged in. Run "swamp auth login", or set SWAMP_API_KEY, to get your recruit link.',
        );
      }

      const identity = await loadIdentity();
      const serverUrl = credentials.serverUrl ??
        Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;

      const client = new SwampClubClient(serverUrl, identity);
      const deps: InviteLinkDeps = {
        fetchRecruitLink: () => client.fetchRecruitLink(credentials.apiKey),
      };

      const libCtx = createLibSwampContext({ logger: ctx.logger });
      const renderer = createInviteLinkRenderer(
        ctx.outputMode,
        ctx.verbosity === "quiet",
      );

      await consumeStream(
        inviteLink(libCtx, deps, {}),
        renderer.handlers(),
      );
    });
}

export const inviteLinkCommand = buildInviteLinkCommand("link", [
  "invite",
  "link",
]);

export const firstRuleCommand = buildInviteLinkCommand("first-rule", [
  "first-rule",
]).hidden();
