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

import { parsePrincipal } from "./principal.ts";

export interface AdmissionResult {
  readonly admitted: boolean;
  readonly reason: string;
}

export function checkAdmission(
  userSub: string,
  collectives: readonly string[],
  allowedCollectives: readonly string[],
  allowedUsers: readonly string[],
): AdmissionResult {
  if (allowedUsers.includes(userSub)) {
    return { admitted: true, reason: "user is in the allowed-users list" };
  }

  if (allowedCollectives.length === 0 && allowedUsers.length === 0) {
    return { admitted: true, reason: "no admission restrictions configured" };
  }

  const matchingCollective = collectives.find((c) =>
    allowedCollectives.includes(c)
  );
  if (matchingCollective) {
    return {
      admitted: true,
      reason: `user is a member of allowed collective '${matchingCollective}'`,
    };
  }

  return {
    admitted: false,
    reason: allowedCollectives.length > 0
      ? `user is not a member of any allowed collective (${
        allowedCollectives.join(", ")
      })`
      : "user is not in the allowed-users list",
  };
}

export interface AdmissionLists {
  readonly allowedCollectives: readonly string[];
  readonly allowedUsers: readonly string[];
}

/**
 * Admission of a credential issued to a person: the rule login and consent
 * apply, over a stored principal. A principal that is not a user fails closed.
 */
export function checkPrincipalAdmission(
  principalId: string,
  collectives: readonly string[],
  lists: AdmissionLists,
): AdmissionResult {
  let principal;
  try {
    principal = parsePrincipal(principalId);
  } catch {
    return { admitted: false, reason: "credential has no valid principal" };
  }
  if (principal.kind !== "user") {
    return { admitted: false, reason: "credential is not a person's" };
  }
  return checkAdmission(
    principal.id,
    collectives,
    lists.allowedCollectives,
    lists.allowedUsers,
  );
}
