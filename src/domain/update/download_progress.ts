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

/** How much of the update archive has arrived so far. */
export interface DownloadProgress {
  readonly receivedBytes: number;
  /** The archive's full size, or null when the server did not say. */
  readonly totalBytes: number | null;
}

/** A download attempt that failed and is about to be retried. */
export interface DownloadRetry {
  /** How many attempts in a row have failed, counting this one. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Why this attempt failed, e.g. "no data received for 30s". */
  readonly reason: string;
  /** The byte offset the next attempt resumes from. */
  readonly resumeFromBytes: number;
}

/** Lets the caller watch and cancel an update download. */
export interface DownloadOptions {
  /** Aborting it cancels the update before the installed binary is touched. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly onRetry?: (retry: DownloadRetry) => void;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"];

/** Formats a byte count for people, e.g. 1536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0
    ? `${value} ${BYTE_UNITS[unit]}`
    : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
