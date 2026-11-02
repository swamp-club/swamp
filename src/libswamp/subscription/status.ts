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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { AccountNoticeView } from "../account_notices/notice.ts";
import {
  type AuthDeps,
  rollUpPlanName,
  whoami,
  type WhoamiCollectiveEntitlement,
  type WhoamiIdentity,
} from "../auth/whoami.ts";

export interface SubscriptionStatusView {
  serverUrl: string;
  collectiveToken: boolean;
  username?: string;
  /** Shown on the identity line only; never part of the JSON document. */
  email?: string;
  collectiveSlug?: string;
  plan: string | null;
  planName: string | null;
  /**
   * false when the server sent no entitlement (older or self-hosted), so no
   * subscriptions reported is never read as free
   */
  entitlementsReported: boolean;
  collectives: WhoamiCollectiveEntitlement[];
  billingUrl: string;
  // absent when the request failed, so a failure never reads as no notices
  notices?: AccountNoticeView[];
}

export type SubscriptionStatusEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; status: SubscriptionStatusView }
  | { kind: "error"; error: SwampError };

/**
 * a personal collective's billing page redirects to /billing on the server, so
 * callers need not know which collectives are personal
 */
export function billingUrl(serverUrl: string, collective?: string): string {
  const base = serverUrl.replace(/\/+$/, "");
  // An empty slug means no collective, so the URL never holds `/o//`.
  return collective
    ? `${base}/o/${encodeURIComponent(collective)}/billing`
    : `${base}/billing`;
}

function toView(identity: WhoamiIdentity): SubscriptionStatusView {
  const collectiveToken = identity.collectiveToken === true;
  return {
    serverUrl: identity.serverUrl,
    collectiveToken,
    ...(collectiveToken
      ? { collectiveSlug: identity.collectiveSlug }
      : { username: identity.username, email: identity.email }),
    plan: identity.plan ?? null,
    planName: rollUpPlanName(identity) ?? null,
    entitlementsReported: identity.collectiveEntitlements !== undefined,
    collectives: identity.collectiveEntitlements ?? [],
    billingUrl: billingUrl(identity.serverUrl),
  };
}

/**
 * delegates to whoami so credential loading, auth.json refresh and the
 * verification proof stay what `swamp auth whoami` does
 */
export async function* subscriptionStatus(
  ctx: LibSwampContext,
  deps: AuthDeps,
  notices?: () => Promise<AccountNoticeView[] | null>,
): AsyncIterable<SubscriptionStatusEvent> {
  // asked alongside whoami and awaited on every path; it never rejects
  const pending = notices?.() ?? Promise.resolve(null);
  try {
    for await (const event of whoami(ctx, deps)) {
      if (event.kind === "completed") {
        const found = await pending;
        yield {
          kind: "completed",
          status: {
            ...toView(event.identity),
            ...(found !== null ? { notices: found } : {}),
          },
        };
      } else {
        yield event;
      }
    }
  } finally {
    await pending;
  }
}
