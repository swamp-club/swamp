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

import type { Data } from "./data.ts";
import type { DataId } from "./data_id.ts";
import type { OwnerDefinition } from "./data_metadata.ts";

/**
 * Repository interface for persisting and retrieving unified Data entities.
 *
 * Supports versioned data storage with ownership validation.
 * Content is stored separately from metadata to support large files.
 */
export interface UnifiedDataRepository {
  /**
   * Finds data by its ID and optional version.
   * If version is not specified, returns the latest version.
   *
   * @param id - The data ID
   * @param version - Optional specific version to retrieve
   * @returns The data metadata if found, or null
   */
  findById(id: DataId, version?: number): Promise<Data | null>;

  /**
   * Finds all versions of data with the given ID.
   *
   * @param id - The data ID
   * @returns Array of data versions, sorted by version descending
   */
  findAllVersions(id: DataId): Promise<Data[]>;

  /**
   * Finds data by name within an owner's scope.
   *
   * @param ownerDefinition - The owner definition to scope the search
   * @param name - The data name
   * @returns The latest version if found, or null
   */
  findByName(
    ownerDefinition: OwnerDefinition,
    name: string,
  ): Promise<Data | null>;

  /**
   * Finds all data owned by the given definition.
   *
   * @param ownerDefinition - The owner definition
   * @returns Array of data entities (latest version of each)
   */
  findByOwner(ownerDefinition: OwnerDefinition): Promise<Data[]>;

  /**
   * Finds all data with a specific tag value.
   *
   * @param tagKey - The tag key to search
   * @param tagValue - The tag value to match
   * @returns Array of matching data entities (latest version of each)
   */
  findByTag(tagKey: string, tagValue: string): Promise<Data[]>;

  /**
   * Saves data with its content.
   * Automatically increments version if data with the same ID exists.
   *
   * @param data - The data metadata
   * @param content - The data content
   * @returns The saved data with updated version
   */
  save(data: Data, content: Uint8Array): Promise<Data>;

  /**
   * Saves data metadata only (for streaming updates).
   *
   * @param data - The data metadata
   */
  saveMetadata(data: Data): Promise<void>;

  /**
   * Appends content to streaming data.
   *
   * @param id - The data ID
   * @param content - The content to append
   */
  append(id: DataId, content: Uint8Array): Promise<void>;

  /**
   * Gets the content of a data artifact.
   *
   * @param id - The data ID
   * @param version - Optional specific version (defaults to latest)
   * @returns The content if found, or null
   */
  getContent(id: DataId, version?: number): Promise<Uint8Array | null>;

  /**
   * Deletes a specific version of data.
   *
   * @param id - The data ID
   * @param version - The version to delete
   */
  deleteVersion(id: DataId, version: number): Promise<void>;

  /**
   * Deletes all versions of data.
   *
   * @param id - The data ID
   */
  deleteAll(id: DataId): Promise<void>;

  /**
   * Applies garbage collection policy to data versions.
   * Removes versions that exceed retention limits.
   *
   * @param id - The data ID
   */
  applyGarbageCollection(id: DataId): Promise<void>;

  /**
   * Validates that the owner can modify this data.
   *
   * @param id - The data ID
   * @param ownerDefinition - The owner attempting the modification
   * @returns true if the owner matches the data's owner
   */
  validateOwnership(
    id: DataId,
    ownerDefinition: OwnerDefinition,
  ): Promise<boolean>;

  /**
   * Gets the next version number for a data ID.
   *
   * @param id - The data ID
   * @returns The next version number (1 if no versions exist)
   */
  getNextVersion(id: DataId): Promise<number>;

  /**
   * Generates a new unique ID.
   */
  nextId(): DataId;

  /**
   * Returns the file path for data content.
   *
   * @param id - The data ID
   * @param version - The version
   * @returns The file path
   */
  getContentPath(id: DataId, version: number): string;

  /**
   * Returns the file path for data metadata.
   *
   * @param id - The data ID
   * @param version - The version
   * @returns The metadata file path
   */
  getMetadataPath(id: DataId, version: number): string;
}
