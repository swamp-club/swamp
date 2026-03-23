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

import type { DataHandle } from "./model.ts";

export interface DataOutputValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Domain service for validating data handles produced by method execution.
 *
 * Spec name validation is now enforced at writer creation time by the
 * resource/file writer factories. This service focuses on detecting duplicate
 * instance names within a single method execution.
 */
export class DataOutputValidationService {
  /**
   * Validates data handles for duplicate instance names.
   */
  validate(
    dataHandles: DataHandle[],
  ): DataOutputValidationResult {
    const errors: string[] = [];

    // Check for duplicate instance names
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
