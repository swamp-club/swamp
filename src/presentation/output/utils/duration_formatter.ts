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

  if (ms % 1000 === 0) {
    return `${seconds}s`;
  } else {
    const decimalSeconds = (ms / 1000).toFixed(1);
    return `${decimalSeconds}s`;
  }
}
