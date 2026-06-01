// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { EventHandlers, IssueSearchEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim } from "@std/fmt/colors";

const MAX_TITLE_WIDTH = 60;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function padEnd(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

class LogIssueSearchRenderer implements Renderer<IssueSearchEvent> {
  handlers(): EventHandlers<IssueSearchEvent> {
    return {
      completed: (e) => {
        const d = e.data;
        if (d.issues.length === 0) {
          writeOutput("No issues found.");
          return;
        }

        for (const issue of d.issues) {
          const num = cyan(`#${issue.number}`);
          const title = truncate(issue.title, MAX_TITLE_WIDTH);
          const meta = dim(
            `${padEnd(issue.type, 8)} ${
              padEnd(issue.status, 12)
            } ${issue.author}`,
          );
          writeOutput(
            `${bold(num)}  ${padEnd(title, MAX_TITLE_WIDTH)}  ${meta}`,
          );
        }

        writeOutput("");
        const showing = d.issues.length;
        if (d.total > showing) {
          writeOutput(dim(`Showing ${showing} of ${d.total} issues`));
        } else {
          writeOutput(dim(`${d.total} issue${d.total === 1 ? "" : "s"}`));
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonIssueSearchRenderer implements Renderer<IssueSearchEvent> {
  handlers(): EventHandlers<IssueSearchEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createIssueSearchRenderer(
  mode: OutputMode,
): Renderer<IssueSearchEvent> {
  switch (mode) {
    case "json":
      return new JsonIssueSearchRenderer();
    case "log":
      return new LogIssueSearchRenderer();
  }
}
