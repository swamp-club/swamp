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

import type { Data } from "./data.ts";
import type { DataId } from "./data_id.ts";
import type { ModelType, ModelTypeInput } from "../models/model_type.ts";
import type { Namespace } from "./namespace.ts";

/**
 * Error thrown when ownership validation fails.
 */
export class OwnershipValidationError extends Error {
  constructor(
    readonly dataName: string,
    readonly existingOwner: { ownerType: string; ownerRef: string },
    readonly newOwner: { ownerType: string; ownerRef: string },
  ) {
    super(
      `Ownership validation failed for "${dataName}": ` +
        `existing owner "${existingOwner.ownerType}:${existingOwner.ownerRef}" ` +
        `does not match new owner "${newOwner.ownerType}:${newOwner.ownerRef}"`,
    );
    this.name = "OwnershipValidationError";
  }
}

/**
 * Result of garbage collection operation.
 */
export interface GarbageCollectionResult {
  versionsRemoved: number;
  bytesReclaimed: number;
}

/**
 * Repository interface for unified Data storage with versioning.
 */
export interface UnifiedDataRepository {
  /**
   * The namespace this repository writes as (giga-swamp Phase 2). Catalog rows
   * produced by this repository — both at runtime and during backfill — are
   * stamped with this namespace. SOLO_NAMESPACE ('') in solo mode.
   */
  readonly namespace: Namespace;

  /**
   * Finds all data across all model types and models.
   *
   * @returns Array of data with their model type and model ID
   */
  findAllGlobal(): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;

  /**
   * Finds data by name, optionally for a specific version.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - Optional version (defaults to latest)
   * @returns The data if found, or null
   */
  findByName(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Data | null>;

  /**
   * Finds data by ID, optionally for a specific version.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataId - The data ID
   * @param version - Optional version (defaults to latest)
   * @returns The data if found, or null
   */
  findById(
    type: ModelType,
    modelId: string,
    dataId: DataId,
    version?: number,
  ): Promise<Data | null>;

  /**
   * Lists all versions for a data name.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @returns Array of version numbers in ascending order
   */
  listVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number[]>;

  /**
   * Finds all data for a model.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @returns Array of data (latest version of each)
   */
  findAllForModel(type: ModelTypeInput, modelId: string): Promise<Data[]>;

  /**
   * Saves data with its content, creating a new version.
   * Validates ownership if data with the same name already exists.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param data - The data entity
   * @param content - The content to save
   * @returns The saved version number
   * @throws OwnershipValidationError if ownership validation fails
   */
  save(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<{ version: number }>;

  /**
   * Appends content to streaming data.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param content - The content to append
   */
  append(
    type: ModelType,
    modelId: string,
    dataName: string,
    content: Uint8Array,
  ): Promise<void>;

  /**
   * Streams content from data.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - Optional version (defaults to latest)
   * @returns Async iterable of content chunks
   */
  stream(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): AsyncIterable<Uint8Array>;

  /**
   * Gets the full content of data.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - Optional version (defaults to latest)
   * @returns The content or null if not found
   */
  getContent(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;

  /**
   * Deletes data, optionally for a specific version.
   * If no version is specified, deletes all versions.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - Optional version to delete (all versions if not specified)
   */
  delete(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<void>;

  /**
   * Removes the latest symlink for expired data (soft delete).
   * Version directories remain on disk but data becomes inaccessible.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   */
  removeLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void>;

  /**
   * Allocates a new version directory without writing content.
   * Used by DataWriter for direct file I/O.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param data - The data entity (for ownership validation)
   * @returns The allocated version number and content file path
   */
  allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
  ): Promise<{ version: number; contentPath: string }>;

  /**
   * Finalizes a previously allocated version by writing metadata and updating symlinks.
   * Content must already exist on disk at the content path.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param data - The data entity
   * @param version - The version number to finalize
   * @returns Size and checksum of the content
   */
  finalizeVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
  ): Promise<{ size: number; checksum: string }>;

  /**
   * Generates a new unique ID.
   */
  nextId(): DataId;

  /**
   * Returns the directory path for a data version.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - The version number
   * @returns The directory path
   */
  getPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string;

  /**
   * Returns the content file path for a data version.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - The version number
   * @returns The content file path
   */
  getContentPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string;

  /**
   * Collects garbage according to each data's garbage collection policy.
   *
   * When `options.dryRun` is true, no versions are deleted — the returned
   * `versionsRemoved` and `bytesReclaimed` reflect what would be removed.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param options - Options for the operation
   * @returns The result of garbage collection
   */
  collectGarbage(
    type: ModelType,
    modelId: string,
    options?: { dryRun?: boolean },
  ): Promise<GarbageCollectionResult>;

  /**
   * Renames a data instance by copying the latest version to a new name
   * and writing a tombstone with a forward reference on the old name.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param oldName - The current data name
   * @param newName - The new data name
   * @returns The rename result with version info
   */
  rename(
    type: ModelType,
    modelId: string,
    oldName: string,
    newName: string,
  ): Promise<
    {
      oldName: string;
      newName: string;
      copiedVersion: number;
      newVersion: number;
    }
  >;

  // --- Sync read methods (for CEL expression evaluation) ---

  /**
   * Gets the latest version number synchronously.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @returns The latest version number, or null if not found
   */
  getLatestVersionSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number | null;

  /**
   * Finds data by name synchronously, optionally for a specific version.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - Optional version (defaults to latest)
   * @returns The data if found, or null
   */
  findByNameSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Data | null;

  /**
   * Lists all versions for a data name synchronously.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @returns Array of version numbers in ascending order
   */
  listVersionsSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number[];

  /**
   * Gets the full content of data synchronously.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - Optional version (defaults to latest)
   * @returns The content or null if not found
   */
  getContentSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Uint8Array | null;

  /**
   * Finds all data for a model synchronously.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @returns Array of data (latest version of each)
   */
  findAllForModelSync(type: ModelType, modelId: string): Data[];

  /**
   * Finds all data across all model types and models synchronously.
   * Used by DataQueryService for catalog backfill in sync contexts.
   *
   * @returns Array of data with their model type and model ID
   */
  findAllGlobalSync(): Array<
    { data: Data; modelType: ModelType; modelId: string }
  >;
}
