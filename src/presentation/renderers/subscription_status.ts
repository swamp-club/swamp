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

import type {
  SubscriptionStatusEvent,
  SubscriptionStatusView,
} from "../../libswamp/subscription/status.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan } from "@std/fmt/colors";
import { collectiveLines } from "./collective_standing.ts";

/** The command that opens the billing page `status` points at. */
const SUBSCRIPTION_START_COMMAND = "swamp subscription start";

/** Plans with nothing to bill: the next step is to buy one. */
const UPGRADE_PLANS: ReadonlySet<string> = new Set(["free", "personal"]);

/**
 * The label in front of the billing link, chosen as swamp-club chooses it.
 *
 * A Personal License is not a plan — no price, seats or subscription, and
 * work use needs a paid one — so it upgrades like free. Admin standing has no
 * billing, and the web hides the link for it too. Any other value, an unknown
 * one included, is a plan someone pays for.
 */
export function callToActionLabel(plan: string | null): string | undefined {
  if (plan === null || UPGRADE_PLANS.has(plan)) return "To upgrade:";
  if (plan === "admin") return undefined;
  return "To manage billing:";
}

/** The first line, worded exactly as `swamp auth whoami` words it. */
function identityLine(status: SubscriptionStatusView): string {
  return status.collectiveToken
    ? `Collective token: ${status.collectiveSlug} on ${status.serverUrl}`
    : `${status.username} (${status.email}) on ${status.serverUrl}`;
}

class LogSubscriptionStatusRenderer
  implements Renderer<SubscriptionStatusEvent> {
  handlers(): EventHandlers<SubscriptionStatusEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: ({ status }) => {
        writeOutput(identityLine(status));

        if (!status.entitlementsReported) {
          writeOutput("This Swamp Club server does not report subscriptions.");
          return;
        }

        if (status.planName) {
          writeOutput(`${bold(cyan("Plan:"))} ${bold(status.planName)}`);
        }
        writeOutput(cyan("Collectives:"));
        writeOutput(collectiveLines(status.collectives).join("\n"));

        const label = callToActionLabel(status.plan);
        if (label) {
          writeOutput("");
          writeOutput(`${label}  ${SUBSCRIPTION_START_COMMAND}`);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonSubscriptionStatusRenderer
  implements Renderer<SubscriptionStatusEvent> {
  handlers(): EventHandlers<SubscriptionStatusEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: ({ status }) => {
        // Built key by key: the view carries fields (email) the document
        // must never include. Trial is kept for every plan, as in
        // `auth whoami --json`, for billing triage.
        console.log(JSON.stringify(
          {
            serverUrl: status.serverUrl,
            ...(status.collectiveToken
              ? { collectiveSlug: status.collectiveSlug }
              : { username: status.username }),
            plan: status.plan,
            planName: status.planName,
            entitlementsReported: status.entitlementsReported,
            collectives: status.collectives,
            billingUrl: status.billingUrl,
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

export function createSubscriptionStatusRenderer(
  mode: OutputMode,
): Renderer<SubscriptionStatusEvent> {
  switch (mode) {
    case "json":
      return new JsonSubscriptionStatusRenderer();
    case "log":
      return new LogSubscriptionStatusRenderer();
  }
}
