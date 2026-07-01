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

import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { bold, green } from "@std/fmt/colors";
import type { QuestEventResult } from "../../domain/quest/quest_event.ts";

export function renderQuestCompletion(
  mode: OutputMode,
  result: QuestEventResult,
): void {
  if (mode !== "log") return;

  writeOutput("");

  for (const obj of result.objectives_completed) {
    writeOutput(
      `  ${bold(green("Quest"))} "${obj.title}" ${green("complete!")}`,
    );
  }

  for (const line of result.lines_completed) {
    const label = line.kind === "diagonal"
      ? `Diagonal ${line.index + 1}`
      : `${line.kind.charAt(0).toUpperCase()}${line.kind.slice(1)} ${
        line.index + 1
      }`;
    writeOutput(`  ${label} ${bold(green("BINGO!"))}`);
  }

  if (result.quest_completed) {
    writeOutput(
      `  ${bold(green("Full board complete!"))}`,
    );
  }
}
