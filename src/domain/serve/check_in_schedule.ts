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

/** the hub sets the cadence; a member keeps it within these bounds */
export const MIN_CHECK_IN_INTERVAL_SECONDS = 5;
export const MAX_CHECK_IN_INTERVAL_SECONDS = 60 * 60;
export const DEFAULT_CHECK_IN_INTERVAL_SECONDS = 30;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
const JITTER = 0.1;

export interface IntervalBounds {
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

export const DEFAULT_INTERVAL_BOUNDS: IntervalBounds = {
  minSeconds: MIN_CHECK_IN_INTERVAL_SECONDS,
  maxSeconds: MAX_CHECK_IN_INTERVAL_SECONDS,
};

/** a reply's interval, or the default when it sent none a member can use */
export function clampIntervalSeconds(
  value: unknown,
  bounds: IntervalBounds = DEFAULT_INTERVAL_BOUNDS,
): number {
  const seconds = typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_CHECK_IN_INTERVAL_SECONDS;
  return Math.min(bounds.maxSeconds, Math.max(bounds.minSeconds, seconds));
}

/** within ±10 %; random is in [0, 1) */
export function jittered(ms: number, random: () => number): number {
  return Math.round(ms * (1 + (random() * 2 - 1) * JITTER));
}

export function nextCheckInDelayMs(
  intervalSeconds: number,
  random: () => number,
): number {
  return jittered(intervalSeconds * 1000, random);
}

export interface BackoffInput {
  readonly intervalSeconds: number;
  /** consecutive failures, counting this one */
  readonly failures: number;
  readonly random: () => number;
  /** a 429's retry-after: a floor, never past the cap */
  readonly retryAfterSeconds?: number;
  readonly maxBackoffMs?: number;
}

/** doubles from the interval up to the cap, with jitter, never a tight loop */
export function backoffDelayMs(input: BackoffInput): number {
  const cap = input.maxBackoffMs ?? MAX_BACKOFF_MS;
  const exponent = Math.min(Math.max(input.failures - 1, 0), 30);
  const base = Math.min(input.intervalSeconds * 1000 * 2 ** exponent, cap);
  const floor = Math.min((input.retryAfterSeconds ?? 0) * 1000, cap);
  return Math.min(Math.max(jittered(base, input.random), floor), cap);
}
