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
  questPass,
  type QuestPassDeps,
} from "../../libswamp/mod.ts";
import {
  createQuestPassRenderer,
  QUEST_TAGLINE,
} from "../../presentation/renderers/quest_pass.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const questCommand = new Command()
  .name("quest")
  .description(QUEST_TAGLINE)
  .example("View quest pass", "swamp quest")
  .option(
    "--full",
    "Show every deed — including completed and not-yet-started — not just the ones in progress.",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["quest", "pass"]);

    const credentials = await new AuthRepository().load();
    const identity = await loadIdentity();
    const serverUrl = credentials?.serverUrl ??
      Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;

    const client = new SwampClubClient(serverUrl, identity);

    // Authenticated → your own pass, claimable on the web. Otherwise the ghost
    // read: the progress this device accrued, keyed by its distinct_id, every
    // reward unclaimed until `swamp auth login` binds it to an account.
    let deps: QuestPassDeps;
    if (credentials?.apiKey) {
      const apiKey = credentials.apiKey;
      deps = {
        ghost: false,
        fetchPass: async () => {
          const who = await client.whoami(apiKey);
          if (!who.authenticated || !who.username) {
            throw new UserError(
              "Could not resolve your identity. Run `swamp auth login` again.",
            );
          }
          return client.fetchGenesisPass(who.username);
        },
      };
    } else {
      if (!identity.distinctId) {
        throw new UserError(
          "No device identity yet — run a swamp command inside a repo first, " +
            "or `swamp auth login` to claim your pass.",
        );
      }
      deps = {
        ghost: true,
        fetchPass: () => client.fetchGhostGenesisPass(),
      };
    }

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createQuestPassRenderer(ctx.outputMode, options.full);

    await consumeStream(
      questPass(libCtx, deps),
      renderer.handlers(),
    );
  });
