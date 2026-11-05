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
 * the outcome of the most recent flush that sent or tried to send entries; a
 * failure keeps the last success so stats can still say what left the machine
 */
export interface TelemetryFlushRecord {
  readonly lastAttemptAt: string;
  readonly lastAttemptOk: boolean;
  readonly lastFailureReason?: string;
  readonly lastSuccessAt?: string;
  readonly lastSentCount?: number;
}

export interface TelemetryFlushAttempt {
  readonly at: Date;
  readonly ok: boolean;
  readonly reason?: string;
  readonly sentCount: number;
}

export function applyFlushAttempt(
  previous: TelemetryFlushRecord | null,
  attempt: TelemetryFlushAttempt,
): TelemetryFlushRecord {
  const at = attempt.at.toISOString();
  if (attempt.ok) {
    return {
      lastAttemptAt: at,
      lastAttemptOk: true,
      lastSuccessAt: at,
      lastSentCount: attempt.sentCount,
    };
  }
  return {
    lastAttemptAt: at,
    lastAttemptOk: false,
    ...(attempt.reason !== undefined
      ? { lastFailureReason: attempt.reason }
      : {}),
    ...(previous?.lastSuccessAt !== undefined
      ? { lastSuccessAt: previous.lastSuccessAt }
      : {}),
    ...(previous?.lastSentCount !== undefined
      ? { lastSentCount: previous.lastSentCount }
      : {}),
  };
}
