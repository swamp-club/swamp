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
