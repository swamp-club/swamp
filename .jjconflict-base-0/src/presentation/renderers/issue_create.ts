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

import type { EventHandlers, IssueCreateEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogIssueCreateRenderer implements Renderer<IssueCreateEvent> {
  handlers(): EventHandlers<IssueCreateEvent> {
    const logger = getSwampLogger(["issue", "create"]);
    return {
      completed: (e) => {
        const data = e.data;
        if (data.method === "created") {
          logger.info(
            "Created {type} report #{number}: {title}",
            { type: data.type, number: data.number, title: data.title },
          );
          logger.info("View at: {url}", { url: data.url });
        } else {
          logger.info(
            "GitHub CLI is not available. Open this URL to submit your {type} report:",
            { type: data.type },
          );
          logger.info("{url}", { url: data.url });
          logger.info("");
          logger.info("Title: {title}", { title: data.title });
          logger.info("");
          logger.info("{body}", { body: data.body });
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonIssueCreateRenderer implements Renderer<IssueCreateEvent> {
  handlers(): EventHandlers<IssueCreateEvent> {
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

export function createIssueCreateRenderer(
  mode: OutputMode,
): Renderer<IssueCreateEvent> {
  switch (mode) {
    case "json":
      return new JsonIssueCreateRenderer();
    case "log":
      return new LogIssueCreateRenderer();
  }
}

/** Data structure for issue editor cancelled output. */
export interface IssueCancelledData {
  type: "bug" | "feature";
  reason: "empty" | "cancelled";
}

export function renderIssueCancelled(
  data: IssueCancelledData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled", ...data }, null, 2));
  } else {
    const logger = getSwampLogger(["issue", "create"]);
    if (data.reason === "empty") {
      logger.info("Issue creation cancelled: no content provided");
    } else {
      logger.info("Issue creation cancelled");
    }
  }
}
