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
  questBoard,
  type QuestBoardDeps,
} from "../../libswamp/mod.ts";
import { createQuestBoardRenderer } from "../../presentation/renderers/quest_board.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const questBoardCommand = new Command()
  .name("board")
  .description("Show the full quest bingo card with progress")
  .example("View bingo card", "swamp quest board")
  .example("View a specific season", "swamp quest board --season swamp-genesis")
  .example("View board as JSON", "swamp quest board --json")
  .option("--season <season:string>", "Season slug to display")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["quest", "board"]);

    const credentials = await new AuthRepository().load();
    if (!credentials?.apiKey) {
      throw new UserError(
        "Not authenticated. Run `swamp auth login` first.",
      );
    }

    const identity = await loadIdentity();
    const serverUrl = credentials.serverUrl ??
      Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;

    const client = new SwampClubClient(serverUrl, identity);
    const deps: QuestBoardDeps = {
      fetchQuestBoard: async (seasonSlug?: string) => {
        const board = await client.fetchQuestBoard(
          credentials.apiKey,
          seasonSlug,
        );
        return { board };
      },
    };

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createQuestBoardRenderer(ctx.outputMode);

    await consumeStream(
      questBoard(libCtx, deps, { seasonSlug: options.season }),
      renderer.handlers(),
    );
  });
