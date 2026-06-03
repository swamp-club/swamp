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
 * Duck-typed check for zod-like schemas.
 *
 * User extensions can bundle their own copy of zod (via their `deno.json`
 * import map). When swamp validates a user's model/vault/driver/datastore
 * definition, the schema object comes from the user's zod instance — and
 * `val instanceof z.ZodType` against swamp's zod returns false because the
 * two constructors are different identities.
 *
 * Rather than forcing users to pin the exact swamp-bundled zod version,
 * we duck-type the check. A value is zod-schema-like when it has:
 *   - a `_def` property (zod's internal-definition convention, present
 *     across every zod version from v3 onward),
 *   - a callable `parse` method (zod's public validation API),
 *   - a callable `safeParse` method (zod's public non-throwing API).
 *
 * This contract is stable across zod major versions and implementation
 * variants. A non-zod object that happens to expose the same shape would
 * pass this check; in that case runtime `.parse()` calls still safely
 * surface errors downstream, so false positives degrade gracefully.
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
