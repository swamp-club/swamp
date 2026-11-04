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

/** Trusted engine launch policy; ordinary CLI execution leaves it unset. */
export interface CommandGuardianPolicy {
  executable: string;
  fence: string;
}
let policy: CommandGuardianPolicy | undefined;

/** Set the installed supervisor executable and return the previous scope. */
export function setCommandGuardian(
  value: CommandGuardianPolicy | undefined,
): CommandGuardianPolicy | undefined {
  const previous = policy;
  policy = value;
  return previous;
}

/** Windows commands remain contained by the engine's Job Object. */
export function getCommandGuardian(): CommandGuardianPolicy | undefined {
  return Deno.build.os === "windows" ? undefined : policy;
}
