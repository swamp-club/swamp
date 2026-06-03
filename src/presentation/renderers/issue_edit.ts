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

import type { EventHandlers, IssueEditEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim } from "@std/fmt/colors";

class LogIssueEditRenderer implements Renderer<IssueEditEvent> {
  handlers(): EventHandlers<IssueEditEvent> {
    return {
      completed: (e) => {
        const d = e.data;
        writeOutput(`Updated issue ${bold(cyan(`#${d.issueNumber}`))}`);
        writeOutput(dim(`View at: ${d.serverUrl}/lab/${d.issueNumber}`));
      },
      noop: (e) => {
        writeOutput(`No changes to issue ${bold(cyan(`#${e.issueNumber}`))}`);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonIssueEditRenderer implements Renderer<IssueEditEvent> {
  handlers(): EventHandlers<IssueEditEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      noop: (e) => {
        console.log(
          JSON.stringify(
            { status: "noop", issueNumber: e.issueNumber },
            null,
            2,
          ),
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createIssueEditRenderer(
  mode: OutputMode,
): Renderer<IssueEditEvent> {
  switch (mode) {
    case "json":
      return new JsonIssueEditRenderer();
    case "log":
      return new LogIssueEditRenderer();
  }
}
