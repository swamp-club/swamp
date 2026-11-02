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

export interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

export interface DownloadRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: string;
  readonly resumeFromBytes: number;
}

export interface DownloadOptions {
  /** Aborting it cancels the update before the installed binary is touched. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly onRetry?: (retry: DownloadRetry) => void;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"];

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
