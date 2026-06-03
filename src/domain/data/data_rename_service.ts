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

import { DataMetadataSchema } from "./data_metadata.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";

/**
 * Result of a data rename operation.
 */
export interface RenameResult {
  oldName: string;
  newName: string;
  modelType: string;
  modelId: string;
  modelName: string;
  copiedVersion: number;
  newVersion: number;
}

/**
 * Service for renaming data instances.
 *
 * Copies the latest version under a new name and writes a tombstone
 * with a forward reference on the old name for backwards compatibility.
 */
export class DataRenameService {
  constructor(
    private readonly dataRepo: UnifiedDataRepository,
    private readonly definitionRepo: DefinitionRepository,
  ) {}

  /**
   * Renames a data instance from oldName to newName.
   *
   * @param modelRef - Model name or ID
   * @param oldName - Current data name
   * @param newName - New data name
   * @returns The rename result
   */
  async rename(
    modelRef: string,
    oldName: string,
    newName: string,
  ): Promise<RenameResult> {
    // Validate new name passes schema checks
    const nameValidation = DataMetadataSchema.shape.name.safeParse(newName);
    if (!nameValidation.success) {
      throw new Error(
        `Invalid new name "${newName}": ${
          nameValidation.error.issues[0].message
        }`,
      );
    }

    // Resolve the model
    const result = await findDefinitionByIdOrName(
      this.definitionRepo,
      modelRef,
    );
    if (!result) {
      throw new Error(`Model not found: ${modelRef}`);
    }
    const { definition, type: modelType } = result;

    // Delegate to the repository
    const renameResult = await this.dataRepo.rename(
      modelType,
      definition.id,
      oldName,
      newName,
    );

    return {
      oldName: renameResult.oldName,
      newName: renameResult.newName,
      modelType: modelType.normalized,
      modelId: definition.id,
      modelName: definition.name,
      copiedVersion: renameResult.copiedVersion,
      newVersion: renameResult.newVersion,
    };
  }
}
