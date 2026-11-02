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

/**
 * extensions can bundle their own zod, so instanceof against swamp's fails;
 * duck-type on _def, parse and safeParse instead, and a false positive still
 * surfaces errors at .parse()
 */
export function isZodSchemaLike(val: unknown): boolean {
  if (val === null || typeof val !== "object") return false;
  const candidate = val as {
    _def?: unknown;
    parse?: unknown;
    safeParse?: unknown;
  };
  return (
    "_def" in candidate &&
    typeof candidate.parse === "function" &&
    typeof candidate.safeParse === "function"
  );
}
