// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { UserError } from "../../domain/errors.ts";

/**
 * Parse an RFC 7231 Retry-After header. Returns a non-negative integer
 * number of seconds, or undefined if the header is missing/unparseable.
 *
 * Accepts both forms:
 *   - delta-seconds: `Retry-After: 120`
 *   - HTTP-date:     `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  // Numeric form (delta-seconds) — handle entirely here so we don't fall
  // through to Date.parse, which would interpret "-1" as a past date.
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber >= 0) {
      return Math.ceil(asNumber);
    }
    return undefined;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds > 0 ? seconds : 0;
}

/**
 * Build the UserError shown when swamp-club returns HTTP 429.
 * Includes the wait hint when Retry-After is parseable and a sign-in
 * hint so unauthenticated callers know how to raise their ceiling.
 */
export function rateLimitError(
  retryAfterSeconds: number | undefined,
): UserError {
  const wait = retryAfterSeconds !== undefined
    ? ` Retry in ${retryAfterSeconds}s.`
    : "";
  return new UserError(
    `Rate limit exceeded.${wait} Sign in with 'swamp auth login' for a higher limit.`,
  );
}
