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

import type { Cron } from "croner";

/**
 * the first slot strictly after `after`; across a DST fall-back croner's
 * nextRun can land at or before its argument, so follow croner's own chain
 * from there, which is the sequence its timer fires
 */
export function nextSlotAfter(cron: Cron, after: Date): Date | null {
  let next = cron.nextRun(after);
  while (next && next.getTime() <= after.getTime()) {
    const chained = cron.nextRun(next);
    // a chain that stalls would never pass `after`
    if (!chained || chained.getTime() <= next.getTime()) return null;
    next = chained;
  }
  return next;
}
