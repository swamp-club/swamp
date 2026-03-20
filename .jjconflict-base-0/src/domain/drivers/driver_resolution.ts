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
 * Source of driver configuration at a particular level.
 */
export interface DriverSource {
  driver?: string;
  driverConfig?: Record<string, unknown>;
}

/**
 * Resolved driver configuration.
 */
export interface ResolvedDriverConfig {
  driver: string;
  driverConfig?: Record<string, unknown>;
}

/**
 * Resolves the effective driver and config using precedence:
 *   step > job > workflow > definition > "raw"
 *
 * The first non-undefined `driver` value wins. Its corresponding
 * `driverConfig` is used as-is (no merging across levels).
 */
export function resolveDriverConfig(
  step?: DriverSource,
  job?: DriverSource,
  workflow?: DriverSource,
  definition?: DriverSource,
): ResolvedDriverConfig {
  const sources: (DriverSource | undefined)[] = [
    step,
    job,
    workflow,
    definition,
  ];

  for (const source of sources) {
    if (source?.driver !== undefined) {
      return {
        driver: source.driver,
        driverConfig: source.driverConfig,
      };
    }
  }

  return { driver: "raw" };
}
