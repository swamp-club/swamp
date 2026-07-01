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

import type { EventHandlers, QuestProgressEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim, green } from "@std/fmt/colors";

function progressBar(completed: number, total: number, width: number): string {
  const filled = total > 0 ? Math.round((completed / total) * width) : 0;
  const empty = width - filled;
  return green("█".repeat(filled)) + dim("░".repeat(empty));
}

class LogQuestProgressRenderer implements Renderer<QuestProgressEvent> {
  handlers(): EventHandlers<QuestProgressEvent> {
    return {
      completed: (e) => {
        const { progress } = e.data;
        const s = progress.season;
        const pct = progress.total_count > 0
          ? Math.round(
            (progress.completed_count / progress.total_count) * 100,
          )
          : 0;

        writeOutput("");
        writeOutput(
          `  ${bold(cyan(s.name))}: ${s.theme}`,
        );

        if (s.active) {
          writeOutput(`  ${dim("Ends:")} ${s.ends_at}`);
        } else {
          writeOutput(`  ${dim("Ended:")} ${s.ends_at}`);
        }

        writeOutput("");
        writeOutput(
          `  Progress: ${
            progressBar(progress.completed_count, progress.total_count, 20)
          }  ${progress.completed_count}/${progress.total_count} (${pct}%)`,
        );
        writeOutput(`  Bingos:   ${progress.lines_completed}`);

        if (progress.quest_completed) {
          writeOutput("");
          writeOutput(
            `  ${bold(green("Quest complete!"))} ${
              dim(`Completed: ${progress.completed_at}`)
            }`,
          );
        }

        writeOutput("");
        writeOutput(
          dim("  Run swamp quest board for the full bingo card"),
        );
        writeOutput("");
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonQuestProgressRenderer implements Renderer<QuestProgressEvent> {
  handlers(): EventHandlers<QuestProgressEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data.progress, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createQuestProgressRenderer(
  mode: OutputMode,
): Renderer<QuestProgressEvent> {
  switch (mode) {
    case "json":
      return new JsonQuestProgressRenderer();
    case "log":
      return new LogQuestProgressRenderer();
  }
}
