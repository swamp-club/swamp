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
import type {
  RefusalReason,
  RepositoryDispatchResult,
} from "../../cli/commands/extension_report_dispatcher.ts";

class LogIssueCreateRenderer implements Renderer<IssueCreateEvent> {
  handlers(): EventHandlers<IssueCreateEvent> {
    const logger = getSwampLogger(["issue", "create"]);
    return {
      completed: (e) => {
        const data = e.data;
        if (data.method === "lab") {
          logger.info(
            "Submitted {type} report #{number}: {title}",
            { type: data.type, number: data.number, title: data.title },
          );
          logger.info("View at: {url}", {
            url: `${data.serverUrl}/lab/${data.number}`,
          });
          if (data.type === "security") {
            logger.info(
              "This security report is visible only to you and the admin team at swamp-club.com.",
            );
          }
        } else if (data.method === "extension-lab") {
          logger.info(
            "Filed #{number} against {extension} on swamp-club Lab: {title}",
            {
              number: data.number,
              extension: data.extensionName,
              title: data.title,
            },
          );
          logger.info("View at: {url}", {
            url: `${data.serverUrl}/lab/${data.number}`,
          });
          if (data.type === "security") {
            logger.info(
              "This security report is visible only to you and the admin team at swamp-club.com.",
            );
          }
        } else {
          logger.info(
            "Opening email client to submit {type} report...",
            { type: data.type },
          );
          logger.info(
            "If your email client did not open, send manually to {email}",
            { email: "support@systeminit.com" },
          );
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
  type: "bug" | "feature" | "security";
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

// ---- Extension-scoped rendering ----

export interface ExtensionRefusalData {
  extensionName: string;
  reason: RefusalReason;
  guidance: string;
}

/**
 * Renders a refusal as informational output — never error-styled.
 * Exit code stays 0; the guidance itself communicates the "can't do
 * that here" outcome.
 */
export function renderExtensionRefusal(
  data: ExtensionRefusalData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify(
        {
          status: "refused",
          extensionName: data.extensionName,
          reason: data.reason,
          guidance: data.guidance,
        },
        null,
        2,
      ),
    );
    return;
  }
  // Split the guidance into lines so the renderer prints each as its own
  // log line — readable on terminals that wrap long single-line logs.
  const logger = getSwampLogger(["issue", "create"]);
  for (const line of data.guidance.split("\n")) {
    logger.info(line);
  }
}

export interface ExtensionRepositoryHandoffData {
  result: RepositoryDispatchResult;
  extensionName: string;
}

/** Renders the completed `dispatchRepositoryReport` result. */
export function renderExtensionRepositoryHandoff(
  data: ExtensionRepositoryHandoffData,
  mode: OutputMode,
): void {
  const result = data.result;

  if (result.kind === "refused") {
    renderExtensionRefusal(
      {
        extensionName: data.extensionName,
        reason: result.reason,
        guidance: result.guidance,
      },
      mode,
    );
    return;
  }

  if (mode === "json") {
    console.log(
      JSON.stringify(
        {
          status: "handoff",
          extensionName: data.extensionName,
          method: result.method,
          variant: result.variant,
          url: result.url,
          number: result.number,
          fallbackIssueUrl: result.fallbackIssueUrl,
          pvrCheckFailed: result.pvrCheckFailed,
          pvrCheckSkipped: result.pvrCheckSkipped,
          nonGithubWarning: result.nonGithubWarning,
          preparedTitle: result.preparedTitle,
          preparedBody: result.preparedBody,
        },
        null,
        2,
      ),
    );
    return;
  }

  const logger = getSwampLogger(["issue", "create"]);

  if (result.variant === "advisory") {
    // Advisory URL is load-bearing — print it on its own line so
    // headless-environment users can see it even if openBrowser is a
    // no-op.
    logger.info(
      "Opened the GitHub private vulnerability report form:",
    );
    logger.info("  {url}", { url: result.url });
    if (result.pvrCheckFailed) {
      logger.info(
        "(PVR status could not be verified — the form will tell you if " +
          "private reporting isn't available on this repo.)",
      );
    }
    if (result.pvrCheckSkipped) {
      logger.info(
        "(gh CLI not available; could not verify PVR status.)",
      );
    }
    if (result.fallbackIssueUrl) {
      logger.info(
        "If the form indicates private reporting isn't enabled, file " +
          "publicly at: {fallback}",
        { fallback: result.fallbackIssueUrl },
      );
    }
    return;
  }

  // Variant "issue"
  if (result.method === "gh") {
    logger.info(
      "Filed issue #{number} at {url} via the gh CLI.",
      { number: result.number, url: result.url },
    );
  } else {
    logger.info(
      "Opened {url} in your browser. The prepared title/body were printed " +
        "above so you can paste if the handoff failed.",
      { url: result.url },
    );
  }
  if (result.nonGithubWarning) {
    logger.info(result.nonGithubWarning);
  }
}
