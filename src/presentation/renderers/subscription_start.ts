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

import type { SubscriptionStartEvent } from "../../libswamp/subscription/start.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

class LogSubscriptionStartRenderer implements Renderer<SubscriptionStartEvent> {
  handlers(): EventHandlers<SubscriptionStartEvent> {
    return {
      // Printed once the outcome is known, so a launcher failure never
      // follows an "Opening" line.
      opening_browser: () => {},
      completed: ({ result: { url, browser } }) => {
        switch (browser) {
          case "opened":
            writeOutput(`Opening ${url} in your browser.`);
            return;
          case "skipped":
            writeOutput(`Manage billing at ${url}`);
            return;
          case "failed":
            writeOutput(
              "Could not open a browser. Open this URL to manage billing:",
            );
            writeOutput(`  ${url}`);
            return;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonSubscriptionStartRenderer
  implements Renderer<SubscriptionStartEvent> {
  handlers(): EventHandlers<SubscriptionStartEvent> {
    return {
      opening_browser: () => {},
      completed: ({ result }) => {
        console.log(JSON.stringify(
          {
            url: result.url,
            opened: result.browser === "opened",
            collective: result.collective,
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createSubscriptionStartRenderer(
  mode: OutputMode,
): Renderer<SubscriptionStartEvent> {
  switch (mode) {
    case "json":
      return new JsonSubscriptionStartRenderer();
    case "log":
      return new LogSubscriptionStartRenderer();
  }
}
