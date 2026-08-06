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
  AuthWhoamiEvent,
  EventHandlers,
  WhoamiCollectiveEntitlement,
  WhoamiIdentity,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim } from "@std/fmt/colors";

/**
 * The entitlement note for one collective: its billing status when paid, its
 * trial when not.
 *
 * A paying collective is never told it is on a free trial — the same rule the
 * web surface applies to its trial banner. It lives here rather than on the
 * server because whoami is also a billing-triage endpoint: the server reports
 * the trial whatever the plan, and `--json` keeps it, so nothing is lost by
 * declining to show it.
 */
function entitlementNote(
  entitlement: WhoamiCollectiveEntitlement,
): string | undefined {
  const paid = entitlement.plan !== undefined && entitlement.plan !== "free";
  if (paid) return entitlement.subscriptionStatus ?? undefined;

  const trial = entitlement.trial;
  if (!trial || trial.state === "none") return undefined;
  if (trial.state === "expired") return "trial expired";

  const days = trial.daysRemaining;
  const unit = days === 1 ? "day" : "days";
  // Render the server's day count as given — it is elapsed-based and so
  // timezone-independent. Recomputing from endsAt locally would reintroduce
  // exactly the zone bug the server avoided. The date is only a hint.
  const ends = trial.endsAt ? ` (ends ${trial.endsAt.slice(0, 10)})` : "";
  return `trial: ${days} ${unit} left${ends}`;
}

/** Display name for the top-level roll-up, borrowed from a matching collective. */
function rollUpPlanName(identity: WhoamiIdentity): string | undefined {
  if (!identity.plan) return undefined;
  const match = identity.collectiveEntitlements?.find(
    (c) => c.plan === identity.plan && c.planName,
  );
  return match?.planName ?? identity.plan;
}

/** The aligned per-collective block. */
function collectiveLines(
  entitlements: WhoamiCollectiveEntitlement[],
): string[] {
  const slugWidth = Math.max(...entitlements.map((c) => c.slug.length));
  const planWidth = Math.max(
    ...entitlements.map((c) => (c.planName ?? c.plan ?? "").length),
  );

  return entitlements.map((c) => {
    const plan = c.planName ?? c.plan ?? "";
    const note = entitlementNote(c);
    const row = `  ${bold(c.slug.padEnd(slugWidth))}  ${
      plan.padEnd(planWidth)
    }`;
    return note ? `${row}  ${dim(note)}` : row.trimEnd();
  });
}

class LogAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        if (e.identity.collectiveToken) {
          writeOutput(
            `Collective token: ${e.identity.collectiveSlug} on ${e.identity.serverUrl}`,
          );
          if (e.identity.scopes && e.identity.scopes.length > 0) {
            writeOutput(`Scopes: ${e.identity.scopes.join(", ")}`);
          }
        } else {
          writeOutput(
            `${e.identity.username} (${e.identity.email}) on ${e.identity.serverUrl}`,
          );
        }

        const entitlements = e.identity.collectiveEntitlements;
        if (entitlements && entitlements.length > 0) {
          const planName = rollUpPlanName(e.identity);
          if (planName) {
            writeOutput(`${bold(cyan("Plan:"))} ${bold(planName)}`);
          }
          writeOutput(cyan("Collectives:"));
          writeOutput(collectiveLines(entitlements).join("\n"));
          return;
        }

        // No entitlement from this server — an older or self-hosted
        // swamp-club. Fall back to the exact output shipped before this
        // existed, so upgrading the CLI alone changes nothing.
        if (e.identity.collectives && e.identity.collectives.length > 0) {
          writeOutput(`Collectives: ${e.identity.collectives.join(", ")}`);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonAuthWhoamiRenderer implements Renderer<AuthWhoamiEvent> {
  handlers(): EventHandlers<AuthWhoamiEvent> {
    return {
      loading_credentials: () => {},
      contacting_server: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            authenticated: true,
            serverUrl: e.identity.serverUrl,
            ...(e.identity.collectiveToken
              ? {
                collectiveToken: true,
                collectiveSlug: e.identity.collectiveSlug,
                scopes: e.identity.scopes,
              }
              : {
                id: e.identity.id,
                username: e.identity.username,
                email: e.identity.email,
                name: e.identity.name,
              }),
            ...(e.identity.collectives
              ? { collectives: e.identity.collectives }
              : {}),
            // Passed through verbatim, trial included regardless of plan —
            // log mode hides a paid collective's trial, but --json is what
            // gets pasted into a billing-triage report and must stay complete.
            ...(e.identity.plan ? { plan: e.identity.plan } : {}),
            ...(e.identity.collectiveEntitlements
              ? { collectiveEntitlements: e.identity.collectiveEntitlements }
              : {}),
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

export function createAuthWhoamiRenderer(
  mode: OutputMode,
): Renderer<AuthWhoamiEvent> {
  switch (mode) {
    case "json":
      return new JsonAuthWhoamiRenderer();
    case "log":
      return new LogAuthWhoamiRenderer();
  }
}
