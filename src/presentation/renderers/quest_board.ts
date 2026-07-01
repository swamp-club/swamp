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

import type { EventHandlers, QuestBoardEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import type { ObjectiveCell } from "../../domain/quest/quest_progress.ts";

function pad(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}

function renderCell(obj: ObjectiveCell, cellWidth: number): string[] {
  const innerWidth = cellWidth - 2;
  if (obj.is_free_space) {
    return [
      " " + pad(bold(cyan("FREE")), innerWidth) + " ",
      " " + pad("", innerWidth) + " ",
      " " + pad("", innerWidth) + " ",
    ];
  }

  const marker = obj.completed ? green("[x]") : "[ ]";
  const title = obj.completed
    ? green(obj.title)
    : obj.current > 0
    ? yellow(obj.title)
    : dim(obj.title);
  const titleLine = `${marker} ${title}`;

  const progressLine = obj.target > 1 && !obj.completed
    ? dim(`${obj.current}/${obj.target}`)
    : "";

  return [
    " " + pad(titleLine, innerWidth) + " ",
    " " + pad(obj.description, innerWidth) + " ",
    " " + pad(progressLine, innerWidth) + " ",
  ];
}

function horizontalLine(
  cols: number,
  cellWidth: number,
  left: string,
  mid: string,
  right: string,
  fill: string,
): string {
  const segments: string[] = [];
  for (let c = 0; c < cols; c++) {
    segments.push(fill.repeat(cellWidth));
  }
  return left + segments.join(mid) + right;
}

class LogQuestBoardRenderer implements Renderer<QuestBoardEvent> {
  handlers(): EventHandlers<QuestBoardEvent> {
    return {
      completed: (e) => {
        const { board } = e.data;
        const { rows, cols } = board.grid_size;
        const cellWidth = 16;

        const completedCount =
          board.objectives.filter((o) => o.completed || o.is_free_space).length;
        const totalCount = board.objectives.length;

        writeOutput("");
        writeOutput(
          ` ${
            bold(cyan(board.season.name.toUpperCase()))
          }: ${board.season.theme}`,
        );
        writeOutput(
          ` ${completedCount}/${totalCount} Complete${
            board.lines_completed.length > 0
              ? ` · ${board.lines_completed.length} Bingo${
                board.lines_completed.length !== 1 ? "s" : ""
              }`
              : ""
          }`,
        );
        writeOutput("");

        const grid: (ObjectiveCell | undefined)[][] = [];
        for (let r = 0; r < rows; r++) {
          grid.push(new Array(cols).fill(undefined));
        }
        for (const obj of board.objectives) {
          const [r, c] = obj.position;
          if (r < rows && c < cols) {
            grid[r][c] = obj;
          }
        }

        const top = horizontalLine(
          cols,
          cellWidth,
          "┌",
          "┬",
          "┐",
          "─",
        );
        const mid = horizontalLine(
          cols,
          cellWidth,
          "├",
          "┼",
          "┤",
          "─",
        );
        const bot = horizontalLine(
          cols,
          cellWidth,
          "└",
          "┴",
          "┘",
          "─",
        );

        writeOutput(` ${top}`);

        for (let r = 0; r < rows; r++) {
          const cellLines: string[][] = [];
          for (let c = 0; c < cols; c++) {
            const obj = grid[r][c];
            if (obj) {
              cellLines.push(renderCell(obj, cellWidth));
            } else {
              cellLines.push([
                " ".repeat(cellWidth),
                " ".repeat(cellWidth),
                " ".repeat(cellWidth),
              ]);
            }
          }

          for (let line = 0; line < 3; line++) {
            const row = cellLines.map((cl) => cl[line]).join("│");
            writeOutput(` │${row}│`);
          }

          if (r < rows - 1) {
            writeOutput(` ${mid}`);
          }
        }

        writeOutput(` ${bot}`);

        if (board.lines_completed.length > 0) {
          writeOutput("");
          for (const line of board.lines_completed) {
            const label = line.kind === "diagonal"
              ? `Diagonal ${line.index + 1}`
              : `${line.kind.charAt(0).toUpperCase()}${line.kind.slice(1)} ${
                line.index + 1
              }`;
            writeOutput(
              `  ${bold(green("BINGO!"))} ${label}`,
            );
          }
        }

        if (board.quest_completed) {
          writeOutput("");
          writeOutput(
            `  ${bold(green("Quest complete!"))}`,
          );
        }

        writeOutput("");
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonQuestBoardRenderer implements Renderer<QuestBoardEvent> {
  handlers(): EventHandlers<QuestBoardEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data.board, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createQuestBoardRenderer(
  mode: OutputMode,
): Renderer<QuestBoardEvent> {
  switch (mode) {
    case "json":
      return new JsonQuestBoardRenderer();
    case "log":
      return new LogQuestBoardRenderer();
  }
}
