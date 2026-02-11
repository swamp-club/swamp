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

/**
 * Formats a duration in milliseconds into a human-readable string.
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 *
 * Examples:
 * - 500 -> "500ms"
 * - 1200 -> "1.2s"
 * - 65000 -> "1m 5s"
 * - 3665000 -> "1h 1m 5s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    return "0ms";
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    const remainingSeconds = seconds % 60;

    const parts = [`${hours}h`];
    if (remainingMinutes > 0) {
      parts.push(`${remainingMinutes}m`);
    }
    if (remainingSeconds > 0) {
      parts.push(`${remainingSeconds}s`);
    }

    return parts.join(" ");
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;

    const parts = [`${minutes}m`];
    if (remainingSeconds > 0) {
      parts.push(`${remainingSeconds}s`);
    }

    return parts.join(" ");
  }

  // Less than 60 seconds but >= 1 second
  if (ms % 1000 === 0) {
    // Exact seconds
    return `${seconds}s`;
  } else {
    // Show decimal seconds for sub-second precision
    const decimalSeconds = (ms / 1000).toFixed(1);
    return `${decimalSeconds}s`;
  }
}
