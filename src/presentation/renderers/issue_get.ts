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
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogIssueGetRenderer implements Renderer<IssueGetEvent> {
  handlers(): EventHandlers<IssueGetEvent> {
    const logger = getSwampLogger(["issue", "get"]);
    return {
      completed: (e) => {
        const d = e.data;
        logger.info("#{number}: {title}", {
          number: d.number,
          title: d.title,
        });
        logger.info("Type: {type}  Status: {status}  Author: {author}", {
          type: d.type,
          status: d.status,
          author: d.author,
        });
        if (d.assignees.length > 0) {
          logger.info("Assignees: {assignees}", {
            assignees: d.assignees.join(", "),
          });
        }
        logger.info("Comments: {count}", { count: d.commentCount });
        if (d.body.length > 0) {
          logger.info("");
          logger.info("{body}", { body: d.body });
        }
        logger.info("");
        logger.info("View at: {url}", {
          url: `${d.serverUrl}/lab/${d.number}`,
        });
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
