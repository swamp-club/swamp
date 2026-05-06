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

import type { EventHandlers, IssueGetEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim } from "@std/fmt/colors";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

class LogIssueGetRenderer implements Renderer<IssueGetEvent> {
  handlers(): EventHandlers<IssueGetEvent> {
    return {
      completed: (e) => {
        const d = e.data;
        writeOutput(`${bold(cyan(`#${d.number}`))} ${d.title}`);
        writeOutput(
          `${bold("Type:")} ${d.type}  ${bold("Status:")} ${d.status}  ${
            bold("Author:")
          } ${d.author}`,
        );
        if (d.assignees.length > 0) {
          writeOutput(`${bold("Assignees:")} ${d.assignees.join(", ")}`);
        }
        writeOutput(`${bold("Comments:")} ${d.commentCount}`);
        if (d.body.length > 0) {
          writeOutput("");
          writeOutput(renderMarkdownToTerminal(d.body));
        }
        writeOutput("");
        writeOutput(dim(`View at: ${d.serverUrl}/lab/${d.number}`));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonIssueGetRenderer implements Renderer<IssueGetEvent> {
  handlers(): EventHandlers<IssueGetEvent> {
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

export function createIssueGetRenderer(
  mode: OutputMode,
): Renderer<IssueGetEvent> {
  switch (mode) {
    case "json":
      return new JsonIssueGetRenderer();
    case "log":
      return new LogIssueGetRenderer();
  }
}
