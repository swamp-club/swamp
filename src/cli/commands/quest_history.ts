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
  questHistory,
  type QuestHistoryDeps,
} from "../../libswamp/mod.ts";
import { createQuestHistoryRenderer } from "../../presentation/renderers/quest_history.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { UserError } from "../../domain/errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const questHistoryCommand = new Command()
  .name("history")
  .description("Show past quest seasons and your results")
  .example("View quest history", "swamp quest history")
  .example("View quest history as JSON", "swamp quest history --json")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["quest", "history"]);

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
    const deps: QuestHistoryDeps = {
      fetchQuestHistory: async () => {
        const seasons = await client.fetchQuestHistory(
          credentials.apiKey,
        );
        return { seasons };
      },
    };

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createQuestHistoryRenderer(ctx.outputMode);

    await consumeStream(
      questHistory(libCtx, deps),
      renderer.handlers(),
    );
  });
