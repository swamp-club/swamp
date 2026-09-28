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

/** First retry waits up to this long. */
export const BASE_DELAY_MS = 500;
/** No retry waits longer than this. */
export const MAX_DELAY_MS = 30_000;

/** Serve closes a session after its 8-hour limit; reconnecting re-authenticates. */
export const SESSION_EXPIRED_CLOSE_CODE = 4002;
/** Serve closes a session whose principal or token was revoked. */
export const PRINCIPAL_REVOKED_CLOSE_CODE = 4003;

/**
 * How long to wait before reconnect attempt `attempt` (0-based): exponential
 * backoff capped at MAX_DELAY_MS, with the second half of each window
 * randomized so tabs that lost serve together do not retry together.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  // 2^6 already passes the cap; clamping keeps large attempts finite.
  const exponent = Math.min(Math.max(attempt, 0), 16);
  const cap = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  return cap / 2 + random() * (cap / 2);
}

/**
 * What to do after a socket closes:
 * - `retry` — reconnect after a backoff delay.
 * - `probe` — the upgrade failed with a token; a browser hides the upgrade's
 *   HTTP status, so ask serve over HTTP whether the token is still accepted.
 * - `recheck-mode` — the upgrade failed without a token; serve may have come
 *   back with auth enabled, so re-read `/auth/info`.
 * - `reauth` — the token is no longer accepted; go back to login.
 */
export type CloseAction = "retry" | "probe" | "recheck-mode" | "reauth";

export function closeAction(close: {
  code: number;
  /** Whether the socket reached open before closing. */
  opened: boolean;
  tokenPresented: boolean;
}): CloseAction {
  if (close.code === PRINCIPAL_REVOKED_CLOSE_CODE && close.tokenPresented) {
    return "reauth";
  }
  if (close.opened) return "retry";
  return close.tokenPresented ? "probe" : "recheck-mode";
}

/** The HTTP status of a token probe, or `network-error` if none arrived. */
export type ProbeResult = number | "network-error";

/**
 * Reads a token probe of `/api/v1/health`. Only 401 means the token was
 * rejected: 403 is a refusal from an older serve that required admin and 429
 * is rate limiting. Any other answer means serve is up yet refused the
 * upgrade, which also happens when it came back with auth off and so never
 * echoes the bearer subprotocol, so re-check the auth mode. No answer means
 * serve is down.
 */
export function probeOutcome(
  result: ProbeResult,
): "retry" | "recheck-mode" | "reauth" {
  if (result === 401) return "reauth";
  return result === "network-error" ? "retry" : "recheck-mode";
}
