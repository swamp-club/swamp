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
import {
  type AuthDeps,
  rollUpPlanName,
  whoami,
  type WhoamiCollectiveEntitlement,
  type WhoamiIdentity,
} from "../auth/whoami.ts";

/**
 * The plan and billing standing of the signed-in operative and each of their
 * collectives — a read of whoami, never a second source of truth.
 */
export interface SubscriptionStatusView {
  serverUrl: string;
  /** True for a collective API key, which names a collective, not a user. */
  collectiveToken: boolean;
  /** The user's handle; absent for a collective token. */
  username?: string;
  /** Shown on the identity line only; never part of the JSON document. */
  email?: string;
  /** The collective a collective token belongs to. */
  collectiveSlug?: string;
  /** Strongest plan across the operative's collectives, as the server sent it. */
  plan: string | null;
  /** Display name for {@link plan}; null when there is none or it is free. */
  planName: string | null;
  /**
   * False when the server sent no entitlement — an older or self-hosted
   * swamp-club — so "no subscriptions reported" is never mistaken for "free".
   */
  entitlementsReported: boolean;
  collectives: WhoamiCollectiveEntitlement[];
  billingUrl: string;
}

export type SubscriptionStatusEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; status: SubscriptionStatusView }
  | { kind: "error"; error: SwampError };

/**
 * The server's billing page, or a collective's, never with a doubled slash.
 * A personal collective's page redirects to `/billing` on the server, so the
 * caller never needs to know which collectives are personal.
 */
export function billingUrl(serverUrl: string, collective?: string): string {
  const base = serverUrl.replace(/\/+$/, "");
  return collective === undefined
    ? `${base}/billing`
    : `${base}/o/${encodeURIComponent(collective)}/billing`;
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
 * Reports subscription standing by delegating to {@link whoami}, so loading
 * credentials, refreshing auth.json and saving the verification proof stay
 * exactly what `swamp auth whoami` does.
 */
export async function* subscriptionStatus(
  ctx: LibSwampContext,
  deps: AuthDeps,
): AsyncIterable<SubscriptionStatusEvent> {
  for await (const event of whoami(ctx, deps)) {
    if (event.kind === "completed") {
      yield { kind: "completed", status: toView(event.identity) };
    } else {
      yield event;
    }
  }
}
