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

export type UsernamesResolved = (
  usernamesBySub: Readonly<Record<string, string>>,
) => void;

const USER_PREFIX = "user:";

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
 * only an OAuth login writes oauthIdentity, never a manual mint; the newest
 * login's name wins since a user can be renamed
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
 * a token records the name at login, so it cannot replace a name a later login
 * or the provider gave, and two tokens of a renamed user cannot make the name
 * alternate
 */
export function addUnknownUsernames(
  usernamesBySub: Record<string, string>,
  learned: Readonly<Record<string, string>>,
): void {
  for (const [sub, username] of Object.entries(learned)) {
    if (!Object.hasOwn(usernamesBySub, sub)) usernamesBySub[sub] = username;
  }
}
