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
 * Branded type for Telemetry IDs.
 */
export type TelemetryId = string & { readonly _brand: unique symbol };

/**
 * Creates a TelemetryId from a string.
 */
export function createTelemetryId(id: string): TelemetryId {
  return id as TelemetryId;
}

/**
 * Generates a new unique TelemetryId.
 */
export function generateTelemetryId(): TelemetryId {
  return crypto.randomUUID() as TelemetryId;
}
