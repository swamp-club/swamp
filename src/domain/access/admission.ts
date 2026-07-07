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
