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

import type { ServeLeaseHolder } from "./serve_datastore_client.ts";
import { serveClockOf } from "./serve_offline.ts";

/**
 * only an explicit lease is held to its end: a run lease renews in short TTLs
 * and ends when its run does, so waiting for it can always help
 */
export function outlastsWait(
  holder: ServeLeaseHolder | undefined,
  deadline: number,
  serveUrl: string,
): boolean {
  if (holder === undefined || !holder.explicit) return false;
  const offsetMs = serveClockOf(serveUrl)?.offsetMs ?? 0;
  return Date.parse(holder.expiresAt) - offsetMs > deadline;
}

/** who holds a lease, in the words a refusal uses */
export function describeHolder(
  heldBy: string,
  holder: ServeLeaseHolder | undefined,
): string {
  if (holder === undefined) {
    return heldBy === "caller"
      ? "another command of this caller"
      : heldBy === "serve"
      ? "serve's own work"
      : "another caller";
  }
  const who = heldBy === "caller"
    ? `${holder.principal} in another checkout or command`
    : holder.principal;
  return holder.explicit
    ? `${who}, under an explicit lease until ${holder.expiresAt} (unless released earlier)`
    : who;
}
