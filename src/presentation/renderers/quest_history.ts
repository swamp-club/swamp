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

import type { EventHandlers, QuestHistoryEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim, green } from "@std/fmt/colors";

class LogQuestHistoryRenderer implements Renderer<QuestHistoryEvent> {
  handlers(): EventHandlers<QuestHistoryEvent> {
    return {
      completed: (e) => {
        const { seasons } = e.data;

        if (seasons.length === 0) {
          writeOutput("");
          writeOutput(dim("  No past seasons yet."));
          writeOutput("");
          return;
        }

        writeOutput("");
        writeOutput(bold("  Quest History"));
        writeOutput("");

        for (const entry of seasons) {
          const status = entry.quest_completed
            ? green("completed")
            : dim(`${entry.completed_count}/${entry.total_count}`);
          const bingos = entry.lines_completed > 0
            ? ` · ${entry.lines_completed} bingo${
              entry.lines_completed !== 1 ? "s" : ""
            }`
            : "";

          writeOutput(
            `  ${bold(cyan(entry.season.name))} ${
              dim(`(${entry.season.starts_at} – ${entry.season.ends_at})`)
            }`,
          );
          writeOutput(
            `    ${entry.season.theme} · ${status}${bingos}`,
          );
          writeOutput("");
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonQuestHistoryRenderer implements Renderer<QuestHistoryEvent> {
  handlers(): EventHandlers<QuestHistoryEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data.seasons, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createQuestHistoryRenderer(
  mode: OutputMode,
): Renderer<QuestHistoryEvent> {
  switch (mode) {
    case "json":
      return new JsonQuestHistoryRenderer();
    case "log":
      return new LogQuestHistoryRenderer();
  }
}
