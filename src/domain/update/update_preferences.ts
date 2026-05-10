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

export type UpdateCadence = "daily" | "weekly";

export const VALID_CADENCES: readonly UpdateCadence[] = [
  "daily",
  "weekly",
] as const;

export interface UpdatePreferences {
  enabled: boolean;
  cadence: UpdateCadence;
  notifiedVersion?: string;
  lastPermissionWarning?: string;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferences = {
  enabled: false,
  cadence: "daily",
};

export function isValidCadence(value: string): value is UpdateCadence {
  return VALID_CADENCES.includes(value as UpdateCadence);
}

export interface UpdatePreferencesRepository {
  read(): Promise<UpdatePreferences>;
  write(preferences: UpdatePreferences): Promise<void>;
}
