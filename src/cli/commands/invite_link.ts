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
import {
  consumeStream,
  createLibSwampContext,
  inviteLink,
  type InviteLinkDeps,
} from "../../libswamp/mod.ts";
import { createInviteLinkRenderer } from "../../presentation/renderers/invite_link.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Builds the recruit-link command under a given name.
 *
 * Called twice: once as the documented `link`, and once as `first-rule`, which
 * is registered hidden. An alias would have worked mechanically, but Cliffy
 * prints aliases in the group's help ("link, first-rule"), and an easter egg
 * listed in help is not one — so `first-rule` is a hidden sibling instead.
 * Both share this body, so they cannot drift.
 */
function buildInviteLinkCommand(name: string): Command {
  return new Command()
    .name(name)
    .description("Print your swamp-club recruit link, creating it on first use")
    .example("Print your recruit link", "swamp invite link")
    .example("Capture the link for a script", "swamp invite link --json")
    .action(async function (options: AnyOptions) {
      const ctx = createContext(options as GlobalOptions, ["invite", name]);

      const credentials = await new AuthRepository().load();
      // Unlike `swamp issue get`, there is no anonymous form of this endpoint —
      // the recruit link is identity-scoped. Fail before the round trip, and
      // name both credential sources so a CI caller is not sent to an
      // interactive login it cannot run.
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
      const renderer = createInviteLinkRenderer(ctx.outputMode);

      await consumeStream(
        inviteLink(libCtx, deps, {}),
        renderer.handlers(),
      );
    });
}

/** The documented command: `swamp invite link`. */
export const inviteLinkCommand = buildInviteLinkCommand("link");

/**
 * The same command under its easter-egg name, registered hidden so it stays
 * out of help, shell completions and the `swamp help --json` schema.
 */
export const inviteFirstRuleCommand = buildInviteLinkCommand("first-rule")
  .hidden();
