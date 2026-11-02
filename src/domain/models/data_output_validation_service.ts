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

import type { DataHandle } from "./model.ts";

export interface DataOutputValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * spec names are validated at writer creation, so this only detects duplicate
 * instance names within one method execution
 */
export class DataOutputValidationService {
  validate(
    dataHandles: DataHandle[],
  ): DataOutputValidationResult {
    const errors: string[] = [];

    const names = new Set<string>();
    for (const handle of dataHandles) {
      if (names.has(handle.name)) {
        errors.push(
          `Duplicate data instance name '${handle.name}'`,
        );
      }
      names.add(handle.name);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
