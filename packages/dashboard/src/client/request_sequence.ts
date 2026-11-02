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
 * Orders the responses of one hook's requests. Each request takes a ticket;
 * only the newest ticket may apply its response, so a slow reply to an
 * earlier payload (v4) can never overwrite a newer one (v5).
 */
export interface RequestSequence {
  /** Starts a request and returns its ticket. */
  next(): number;
  /** True while no later request has started. */
  isCurrent(ticket: number): boolean;
  /** Retires every outstanding ticket, e.g. on unmount. */
  invalidate(): void;
}

export function createRequestSequence(): RequestSequence {
  let latest = 0;
  return {
    next: () => ++latest,
    isCurrent: (ticket) => ticket === latest,
    invalidate: () => {
      latest++;
    },
  };
}
