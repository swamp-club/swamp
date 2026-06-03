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

/** Number of days after which a version is considered stale */
export const VERSION_STALENESS_THRESHOLD_DAYS = 30;

/**
 * Extracts a Date from a CalVer version string.
 * CalVer format: YYYYMMDD.HHMMSS.patch-sha.hash
 * The first 8 characters represent the date: YYYYMMDD.
 *
 * Returns null if the version string doesn't contain a valid date.
 */
export function parseDateFromVersion(version: string): Date | null {
  if (version.length < 8) return null;

  const dateStr = version.substring(0, 8);
  if (!/^\d{8}$/.test(dateStr)) return null;

  const year = parseInt(dateStr.substring(0, 4), 10);
  const month = parseInt(dateStr.substring(4, 6), 10);
  const day = parseInt(dateStr.substring(6, 8), 10);

  // Basic validation
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));

  // Verify the date components match (catches invalid dates like Feb 30)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/**
 * Returns the age of the version in days, or null if the version
 * date cannot be parsed.
 */
export function getVersionAgeDays(
  version: string,
  now: Date,
): number | null {
  const versionDate = parseDateFromVersion(version);
  if (!versionDate) return null;

  const diffMs = now.getTime() - versionDate.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Returns true if the version is older than `thresholdDays` days.
 */
export function isVersionStale(
  version: string,
  now: Date,
  thresholdDays: number,
): boolean {
  const ageDays = getVersionAgeDays(version, now);
  if (ageDays === null) return false;
  return ageDays > thresholdDays;
}
