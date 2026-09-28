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
 * How to treat the health stream's HTTP status: read it, stop because serve
 * refused this token, or try again later (rate limiting, the per-token stream
 * cap, a server error).
 */
export function healthStreamOutcome(
  status: number,
): "ok" | "denied" | "retry" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "denied";
  return "retry";
}

/**
 * What a view built on the health snapshot should show. The empty state is
 * only right for a snapshot that really has nothing in it; a refused or
 * not-yet-arrived snapshot must not look like one.
 */
export function healthViewState(
  health: object | null,
  denied: boolean,
): "denied" | "loading" | "ready" {
  if (denied) return "denied";
  return health === null ? "loading" : "ready";
}

export const HEALTH_RETRY_MS = 5000;
const MAX_RETRY_MS = 120_000;

/**
 * How long to wait before reconnecting after a retryable answer: the server's
 * `Retry-After` in seconds when it sent one (as it does at the per-token
 * stream cap), bounded to 5 s–2 min, otherwise 5 s.
 */
export function healthRetryDelayMs(retryAfter: string | null): number {
  if (retryAfter === null) return HEALTH_RETRY_MS;
  const seconds = Number(retryAfter.trim());
  if (!Number.isFinite(seconds) || retryAfter.trim() === "") {
    return HEALTH_RETRY_MS;
  }
  return Math.min(MAX_RETRY_MS, Math.max(HEALTH_RETRY_MS, seconds * 1000));
}
