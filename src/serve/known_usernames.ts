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

import {
  type Principal,
  principalToString,
} from "../domain/access/principal.ts";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import type { ActorIdentity } from "../domain/serve_audit/audit_event.ts";

/**
 * Records user names by user id. Serve learns names from OAuth logins and from
 * the tokens they minted, and adds them to the names it resolved from its
 * configuration, so audit events and messages name a user who was admitted
 * through a collective or group rather than by name.
 */
export type UsernamesResolved = (
  usernamesBySub: Readonly<Record<string, string>>,
) => void;

const USER_PREFIX = "user:";

/**
 * The user name the OAuth provider gave for a user principal at login, keyed
 * by the principal's id. Empty for another kind of principal, or when the
 * provider sent no username.
 */
export function usernameFromLogin(
  principalId: string,
  identity: ActorIdentity | undefined,
): Record<string, string> {
  if (!principalId.startsWith(USER_PREFIX)) return {};
  const sub = principalId.slice(USER_PREFIX.length);
  if (!sub || !identity?.username) return {};
  return { [sub]: identity.username };
}

/**
 * The user names recorded on server tokens minted by an OAuth login, keyed by
 * user id. Only an OAuth login writes `oauthIdentity`, never a manual mint, so
 * a name here is one the provider gave. Where a user has several tokens the
 * newest login's name wins, as a user can be renamed.
 */
export function usernamesFromServerTokens(
  tokens: readonly ServerToken[],
): Record<string, string> {
  const newestFirst = [...tokens].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const usernamesBySub: Record<string, string> = {};
  for (const token of newestFirst) {
    for (
      const [sub, username] of Object.entries(
        usernameFromLogin(token.principalId, token.oauthIdentity),
      )
    ) {
      if (!Object.hasOwn(usernamesBySub, sub)) usernamesBySub[sub] = username;
    }
  }
  return usernamesBySub;
}

/**
 * A principal's display name: `user:<name>` for a user whose id has a known
 * user name, otherwise the principal itself.
 */
export function displayPrincipal(
  principal: Principal,
  usernamesBySub: Readonly<Record<string, string>> | undefined,
): string {
  if (
    principal.kind === "user" && usernamesBySub &&
    Object.hasOwn(usernamesBySub, principal.id) &&
    usernamesBySub[principal.id]
  ) {
    return `user:${usernamesBySub[principal.id]}`;
  }
  return principalToString(principal);
}

/**
 * Adds the names for users `usernamesBySub` does not name yet. A token records
 * the name its user had at login, so a token cannot replace a name a later
 * login or the provider gave, and two tokens of a renamed user cannot make the
 * name alternate.
 */
export function addUnknownUsernames(
  usernamesBySub: Record<string, string>,
  learned: Readonly<Record<string, string>>,
): void {
  for (const [sub, username] of Object.entries(learned)) {
    if (!Object.hasOwn(usernamesBySub, sub)) usernamesBySub[sub] = username;
  }
}
