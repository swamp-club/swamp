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
 * Computes a composite data name from a base name and vary dimension values.
 *
 * When vary dimensions are provided, the resulting name is
 * `{baseName}-{value1}-{value2}-...`. When the vary array is empty,
 * the base name is returned unchanged.
 *
 * @param baseName - The original data name
 * @param varyValues - Resolved dimension values to append
 * @returns The composite data name
 * @throws Error if baseName is empty or any varyValue is empty
 */
export function composeDataName(
  baseName: string,
  varyValues: string[],
): string {
  if (baseName.trim() === "") {
    throw new Error("Base name must be a non-empty string");
  }

  if (varyValues.length === 0) {
    return baseName;
  }

  for (let i = 0; i < varyValues.length; i++) {
    if (varyValues[i].trim() === "") {
      throw new Error(
        `Vary value at index ${i} must be a non-empty string`,
      );
    }
    if (/[\/\\]/.test(varyValues[i])) {
      throw new Error(
        `Vary value at index ${i} contains path separator characters: ${
          varyValues[i]
        }`,
      );
    }
    if (varyValues[i] === "." || varyValues[i] === "..") {
      throw new Error(
        `Vary value at index ${i} must not be a relative path component: ${
          varyValues[i]
        }`,
      );
    }
  }

  return `${baseName}-${varyValues.join("-")}`;
}
