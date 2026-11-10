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

import { scanExpressions } from "./expression_scanner.ts";

/**
 * walks what resolveDatastoreExpressions walks and matches what it would
 * resolve; iterative, since a remote client controls the nesting depth
 */
export function containsExpressions(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      if (scanExpressions(next).length > 0) return true;
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (next !== null && typeof next === "object") {
      for (const item of Object.values(next)) pending.push(item);
    }
  }
  return false;
}
