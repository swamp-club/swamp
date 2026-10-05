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

export type UpdateCadence = "hourly" | "daily" | "weekly";

export const VALID_CADENCES: readonly UpdateCadence[] = [
  "hourly",
  "daily",
  "weekly",
] as const;

export interface UpdatePreferences {
  enabled: boolean;
  cadence: UpdateCadence;
  notifiedVersion?: string;
  lastPermissionWarning?: string;
  /** Binary version the launchd autoupdate job was last re-registered for. */
  schedulerRefreshedVersion?: string;
  /** When re-registering the launchd autoupdate job last failed. */
  lastSchedulerRefreshAttempt?: string;
  /** A failed re-registration took the job out of launchd without loading it. */
  schedulerLeftUnloaded?: boolean;
  /** When the "autoupdate has stopped checking" warning was last shown. */
  lastStaleWarning?: string;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  enabled: false,
  cadence: "daily",
};

/**
 * Copies the fields the CLI's post-command notices own (shown-notice and
 * warning timestamps) from `notices` onto `latest`, a fresh read of the
 * preferences. Writing the result instead of a whole earlier snapshot keeps
 * a concurrent scheduler refresh's fields from being rolled back.
 */
export function withNoticeFields(
  latest: UpdatePreferences,
  notices: UpdatePreferences,
): UpdatePreferences {
  return {
    ...latest,
    notifiedVersion: notices.notifiedVersion,
    lastPermissionWarning: notices.lastPermissionWarning,
    lastStaleWarning: notices.lastStaleWarning,
  };
}

export function isValidCadence(value: string): value is UpdateCadence {
  return VALID_CADENCES.includes(value as UpdateCadence);
}

export interface UpdatePreferencesRepository {
  read(): Promise<UpdatePreferences>;
  write(preferences: UpdatePreferences): Promise<void>;
}
