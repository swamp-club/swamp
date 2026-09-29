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

/** How long repeated rejections on one route and reason share one event. */
export const DEFAULT_REJECTION_WINDOW_MS = 60_000;

export interface RejectionAdmission {
  /** Whether this rejection should be written to the audit log. */
  readonly emit: boolean;
  /** Rejections dropped since the last one written for this key. */
  readonly suppressed: number;
}

/**
 * Bounds audit volume from unauthenticated webhook traffic. The first
 * rejection for a route and reason in each window is written with the count
 * dropped since the previous one; the rest of the window is counted, not
 * written. Keys are configured routes and a fixed set of reasons, so the map
 * stays bounded by configuration.
 */
export class WebhookRejectionCoalescer {
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<
    string,
    { startedAt: number; suppressed: number }
  >();

  constructor(
    options: { windowMs?: number; now?: () => number } = {},
  ) {
    this.#windowMs = options.windowMs ?? DEFAULT_REJECTION_WINDOW_MS;
    this.#now = options.now ?? Date.now;
  }

  admit(route: string, reason: string): RejectionAdmission {
    const key = `${route}\u0000${reason}`;
    const now = this.#now();
    const window = this.#windows.get(key);
    if (window && now - window.startedAt < this.#windowMs) {
      window.suppressed++;
      return { emit: false, suppressed: window.suppressed };
    }
    const suppressed = window?.suppressed ?? 0;
    this.#windows.set(key, { startedAt: now, suppressed: 0 });
    return { emit: true, suppressed };
  }
}
