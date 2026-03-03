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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

/**
 * Data structure for issue creation output.
 * Discriminated union: "created" when issue was created via gh CLI, "url" when falling back to a browser URL.
 */
export type IssueCreateData =
  | {
    method: "created";
    url: string;
    number: number;
    type: "bug" | "feature";
    title: string;
  }
  | {
    method: "url";
    url: string;
    type: "bug" | "feature";
    title: string;
    body: string;
    labels: string[];
  };

/**
 * Renders issue creation output in either log or JSON mode.
 */
export function renderIssueCreate(
  data: IssueCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["issue", "create"]);
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
  }
}

/**
 * Data structure for issue editor cancelled output.
 */
export interface IssueCancelledData {
  type: "bug" | "feature";
  reason: "empty" | "cancelled";
}

/**
 * Renders issue cancelled output in either log or JSON mode.
 */
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
