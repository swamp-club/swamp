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

import { join, resolve } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { atomicWriteFile, atomicWriteTextFile } from "./atomic_write.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  Data,
  type DataId,
  type DataMetadata,
  generateDataId,
  isReservedDataName,
  type OwnerDefinition,
} from "../../domain/data/mod.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { CatalogStore } from "./catalog_store.ts";

const logger = getSwampLogger(["data", "repository"]);

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
    type: ModelType,
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
  findAllForModel(type: ModelType, modelId: string): Promise<Data[]>;

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
    type: ModelType,
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
   * @param type - The model type
   * @param modelId - The model input ID
   * @returns The result of garbage collection
   */
  collectGarbage(
    type: ModelType,
    modelId: string,
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

/**
 * File system implementation of UnifiedDataRepository.
 *
 * Storage layout:
 * .swamp/data/{normalized-type}/{model-id}/{data-name}/
 *   1/
 *     raw              # Content (binary or text)
 *     metadata.yaml    # Metadata
 *   2/
 *     raw
 *     metadata.yaml
 *   latest/            # Symlink -> 2/
 */
export class FileSystemUnifiedDataRepository implements UnifiedDataRepository {
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly catalogStore?: CatalogStore,
  ) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.data);
  }

  private catalogUpsert(type: ModelType, modelId: string, data: Data): void {
    if (!this.catalogStore) return;
    this.catalogStore.upsert({
      type_normalized: type.normalized,
      model_id: modelId,
      data_name: data.name,
      id: data.id,
      version: data.version,
      model_name: data.tags["modelName"] ?? "",
      spec_name: data.tags["specName"] ?? "",
      data_type: data.tags["type"] ?? "",
      content_type: data.contentType,
      lifetime: data.lifetime,
      owner_type: data.ownerDefinition.ownerType,
      streaming: data.streaming ? 1 : 0,
      size: data.size ?? 0,
      created_at: data.createdAt.toISOString(),
      tags: JSON.stringify(data.tags),
      owner_ref: data.ownerDefinition.ownerRef,
      workflow_run_id: data.ownerDefinition.workflowRunId ?? "",
      workflow_name: data.ownerDefinition.workflowName ?? "",
      job_name: data.ownerDefinition.jobName ?? "",
      step_name: data.ownerDefinition.stepName ?? "",
      source: data.ownerDefinition.source ?? "",
    });
  }

  private catalogRemove(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): void {
    if (!this.catalogStore) return;
    this.catalogStore.remove(type.normalized, modelId, dataName);
  }

  async findAllGlobal(): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > {
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    const baseDir = this.getBaseDir();

    await this.collectAllData(baseDir, [], results);

    return results;
  }

  /**
   * Recursively collects all data from the directory tree.
   * Walks .swamp/data/{type-segments...}/{model-id}/{data-name}/ structure.
   *
   * When a directory contains a subdirectory with numeric version directories
   * (or a "latest" symlink), we've reached a data-name level. The path segments
   * before the model-id form the model type.
   */
  private async collectAllData(
    currentDir: string,
    pathSegments: string[],
    results: Array<{ data: Data; modelType: ModelType; modelId: string }>,
  ): Promise<void> {
    try {
      const entries: { name: string; isDirectory: boolean }[] = [];
      for await (const entry of Deno.readDir(currentDir)) {
        if (entry.isDirectory) {
          entries.push({ name: entry.name, isDirectory: true });
        }
      }

      // Check if we're at a model-id level by seeing if any child directories
      // contain data-name directories (which contain version subdirectories)
      for (const entry of entries) {
        const childPath = join(currentDir, entry.name);
        const childSegments = [...pathSegments, entry.name];

        // Try to determine if this is a model-id directory by checking if
        // its children look like data-name directories (containing version dirs)
        const isModelIdDir = await this.isModelIdDirectory(childPath);

        if (isModelIdDir && childSegments.length >= 2) {
          // pathSegments = type segments, entry.name = model ID
          const typeSegments = pathSegments;
          const modelId = entry.name;
          const typeStr = typeSegments.join("/");

          try {
            const modelType = ModelType.create(typeStr);
            const dataItems = await this.findAllForModel(modelType, modelId);
            for (const data of dataItems) {
              results.push({ data, modelType, modelId });
            }
          } catch {
            // Skip invalid model types
          }
        } else {
          // Keep recursing deeper into type directories
          await this.collectAllData(childPath, childSegments, results);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  /**
   * Checks if a directory looks like a model-id directory by examining
   * if its children contain version subdirectories or a "latest" symlink.
   */
  private async isModelIdDirectory(dir: string): Promise<boolean> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isDirectory && !entry.isSymlink) continue;

        // Check if this child is a data-name directory by looking for
        // numeric version subdirectories (1/, 2/, 3/, ...).
        // We intentionally skip checking for "latest" here because a data
        // item could be literally named "latest", which would cause a
        // type directory to be misidentified as a model-ID directory.
        const childPath = join(dir, entry.name);
        try {
          for await (const subEntry of Deno.readDir(childPath)) {
            if (subEntry.isDirectory && /^\d+$/.test(subEntry.name)) {
              return true;
            }
          }
        } catch {
          // Skip unreadable directories
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return false;
  }

  findByName(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Data | null> {
    return this.findByNameWithDepth(type, modelId, dataName, version, 0);
  }

  private async findByNameWithDepth(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number | undefined,
    depth: number,
  ): Promise<Data | null> {
    const versionToRead = version ?? (await this.getLatestVersion(
      type,
      modelId,
      dataName,
    ));
    if (versionToRead === null) return null;

    const metadataPath = this.getMetadataPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    try {
      const content = await Deno.readTextFile(metadataPath);
      const metadata = parseYaml(content) as DataMetadata;
      const data = Data.fromData(metadata);

      // Follow forward references for latest lookups (not explicit version requests)
      if (version === undefined && data.isRenamed && data.renamedTo) {
        if (depth >= 5) {
          logger
            .warn`Rename chain depth exceeded for "${dataName}" (model ${modelId}). Data exists but is unreachable — simplify the rename chain.`;
          return null;
        }
        return this.findByNameWithDepth(
          type,
          modelId,
          data.renamedTo,
          undefined,
          depth + 1,
        );
      }

      return data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async findById(
    type: ModelType,
    modelId: string,
    dataId: DataId,
    version?: number,
  ): Promise<Data | null> {
    // We need to scan all data directories to find the one with this ID
    const dataDir = this.getModelDataDir(type, modelId);
    try {
      for await (const entry of Deno.readDir(dataDir)) {
        if (!entry.isDirectory) continue;
        const dataName = entry.name;

        const data = await this.findByName(type, modelId, dataName, version);
        if (data && data.id === dataId) {
          return data;
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
    return null;
  }

  async listVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number[]> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    const versions: number[] = [];

    try {
      for await (const entry of Deno.readDir(dataNameDir)) {
        if (!entry.isDirectory) continue;
        if (entry.name === "latest") continue;

        const version = parseInt(entry.name, 10);
        if (!isNaN(version) && version > 0) {
          versions.push(version);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return versions.sort((a, b) => a - b);
  }

  async findAllForModel(type: ModelType, modelId: string): Promise<Data[]> {
    const dataDir = this.getModelDataDir(type, modelId);
    const results: Data[] = [];
    const seen = new Set<string>();

    try {
      for await (const entry of Deno.readDir(dataDir)) {
        if (!entry.isDirectory) continue;
        const dataName = entry.name;

        const data = await this.findByName(type, modelId, dataName);
        if (data && !seen.has(data.name)) {
          seen.add(data.name);
          results.push(data);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results;
  }

  async save(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<{ version: number }> {
    // Reject reserved data names that collide with internal markers
    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    // Check if data with this name already exists
    const existing = await this.findByName(type, modelId, data.name);
    if (existing) {
      // Validate ownership
      if (!existing.isOwnedBy(data.ownerDefinition)) {
        throw new OwnershipValidationError(
          data.name,
          existing.ownerDefinition,
          data.ownerDefinition,
        );
      }
    }

    // Atomically allocate a new version directory
    const { version: newVersion } = await this.atomicAllocateVersionDir(
      type,
      modelId,
      data.name,
    );

    // Create the data with updated version and size
    const dataToSave = data.withNewVersion({
      version: newVersion,
      size: content.length,
      checksum: await this.computeChecksum(content),
    });

    // Save metadata
    const metadataPath = this.getMetadataPath(
      type,
      modelId,
      data.name,
      newVersion,
    );
    const boundary = this.baseDir;
    await assertSafePath(metadataPath, boundary);
    const metadata = dataToSave.toData();
    // Remove undefined values
    const cleanData = JSON.parse(JSON.stringify(metadata));
    const metadataContent = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(metadataPath, metadataContent);

    // Save content
    const contentPath = this.getContentPath(
      type,
      modelId,
      data.name,
      newVersion,
    );
    await assertSafePath(contentPath, boundary);
    await atomicWriteFile(contentPath, content);

    // Update latest symlink
    await this.updateLatestMarker(type, modelId, data.name, newVersion);

    this.catalogUpsert(type, modelId, dataToSave);

    return { version: newVersion };
  }

  async append(
    type: ModelType,
    modelId: string,
    dataName: string,
    content: Uint8Array,
  ): Promise<void> {
    const latestVersion = await this.getLatestVersion(type, modelId, dataName);
    if (latestVersion === null) {
      throw new Error(`No existing data found for "${dataName}"`);
    }

    const data = await this.findByName(type, modelId, dataName, latestVersion);
    if (!data?.streaming) {
      throw new Error(`Data "${dataName}" is not configured for streaming`);
    }

    const contentPath = this.getContentPath(
      type,
      modelId,
      dataName,
      latestVersion,
    );
    await assertSafePath(contentPath, this.baseDir);
    const file = await Deno.open(contentPath, { append: true });
    try {
      await file.write(content);
    } finally {
      file.close();
    }

    // Update metadata with new size (O(1) via stat, no file read)
    const stat = await Deno.stat(contentPath);
    const metadataPath = this.getMetadataPath(
      type,
      modelId,
      dataName,
      latestVersion,
    );
    const metadata = data.toData();
    metadata.size = stat.size;
    // Remove stale checksum — content has changed and recomputing
    // would require reading the entire file into memory
    delete metadata.checksum;
    const cleanData = JSON.parse(JSON.stringify(metadata));
    await atomicWriteTextFile(
      metadataPath,
      stringifyYaml(cleanData as Record<string, unknown>),
    );

    // Update catalog with new size
    const updatedData = Data.fromData(metadata);
    this.catalogUpsert(type, modelId, updatedData);
  }

  async *stream(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): AsyncIterable<Uint8Array> {
    const versionToRead = version ??
      await this.getLatestVersion(type, modelId, dataName);
    if (versionToRead === null) return;

    const contentPath = this.getContentPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );

    try {
      const file = await Deno.open(contentPath, { read: true });
      try {
        const buffer = new Uint8Array(8192);
        while (true) {
          const bytesRead = await file.read(buffer);
          if (bytesRead === null) break;
          yield buffer.slice(0, bytesRead);
        }
      } finally {
        file.close();
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return;
      }
      throw error;
    }
  }

  async getContent(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null> {
    const versionToRead = version ??
      await this.getLatestVersion(type, modelId, dataName);
    if (versionToRead === null) return null;

    const contentPath = this.getContentPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    try {
      return await Deno.readFile(contentPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async delete(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<void> {
    if (version !== undefined) {
      // Delete specific version
      const versionDir = this.getPath(type, modelId, dataName, version);
      try {
        await Deno.remove(versionDir, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      // Update latest symlink if needed
      const versions = await this.listVersions(type, modelId, dataName);
      if (versions.length > 0) {
        const newLatest = Math.max(...versions);
        await this.updateLatestMarker(type, modelId, dataName, newLatest);
        // Update catalog to reflect new latest version
        const latestData = await this.findByName(
          type,
          modelId,
          dataName,
          newLatest,
        );
        if (latestData) {
          this.catalogUpsert(type, modelId, latestData);
        }
      } else {
        // No versions left, remove the data name directory
        const dataNameDir = this.getDataNameDir(type, modelId, dataName);
        await Deno.remove(dataNameDir, { recursive: true }).catch(() => {});
        this.catalogRemove(type, modelId, dataName);
      }
    } else {
      // Delete all versions
      const dataNameDir = this.getDataNameDir(type, modelId, dataName);
      try {
        await Deno.remove(dataNameDir, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
      this.catalogRemove(type, modelId, dataName);
    }
  }

  /**
   * Removes the latest symlink for expired data (soft delete).
   * Version directories remain on disk but data becomes inaccessible.
   */
  async removeLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    const latestSymlink = join(dataNameDir, "latest");

    try {
      await Deno.remove(latestSymlink);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
      // Symlink already missing is OK
    }

    this.catalogRemove(type, modelId, dataName);
  }

  async rename(
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
  > {
    // Read the latest version of old data
    const oldData = await this.findByName(type, modelId, oldName);
    if (!oldData) {
      throw new Error(`Data "${oldName}" not found`);
    }
    if (oldData.isDeleted) {
      throw new Error(`Data "${oldName}" is already deleted or renamed`);
    }

    // Verify new name doesn't already have active data
    const existingNew = await this.findByName(type, modelId, newName);
    if (existingNew && !existingNew.isDeleted) {
      throw new Error(`Data "${newName}" already exists`);
    }

    // Read the content to copy
    const content = await this.getContent(
      type,
      modelId,
      oldName,
      oldData.version,
    );
    if (!content) {
      throw new Error(
        `Content not found for "${oldName}" version ${oldData.version}`,
      );
    }

    // Create new data under the new name with a fresh ID
    const newData = Data.create({
      name: newName,
      contentType: oldData.contentType,
      lifetime: oldData.lifetime,
      garbageCollection: oldData.garbageCollection,
      streaming: oldData.streaming,
      tags: { ...oldData.tags },
      ownerDefinition: { ...oldData.ownerDefinition },
    });

    // Save under the new name
    const { version: newVersion } = await this.save(
      type,
      modelId,
      newData,
      content,
    );

    // Write a tombstone with forward reference on the old name.
    // If this fails, roll back the newly saved data to avoid an inconsistent
    // state where both old and new names have valid active data.
    try {
      const versions = await this.listVersions(type, modelId, oldName);
      const nextTombstoneVersion = Math.max(...versions) + 1;
      const tombstone = oldData.withRenameMarker({
        version: nextTombstoneVersion,
        renamedTo: newName,
      });

      // Save tombstone metadata and content
      const { version: tombstoneVersion } = await this.atomicAllocateVersionDir(
        type,
        modelId,
        oldName,
      );
      const tombstoneData = tombstone.withNewVersion({
        version: tombstoneVersion,
      });

      const tombstoneContent = new TextEncoder().encode(
        JSON.stringify({
          renamedTo: newName,
          renamedAt: new Date().toISOString(),
        }),
      );

      const metadataPath = this.getMetadataPath(
        type,
        modelId,
        oldName,
        tombstoneVersion,
      );
      const boundary = this.baseDir;
      await assertSafePath(metadataPath, boundary);
      const metadata = tombstoneData.toData();
      const cleanData = JSON.parse(JSON.stringify(metadata));
      const metadataYaml = stringifyYaml(
        cleanData as Record<string, unknown>,
      );
      await atomicWriteTextFile(metadataPath, metadataYaml);

      const contentPath = this.getContentPath(
        type,
        modelId,
        oldName,
        tombstoneVersion,
      );
      await assertSafePath(contentPath, boundary);
      await atomicWriteFile(contentPath, tombstoneContent);

      // Update latest marker to point to tombstone
      await this.updateLatestMarker(type, modelId, oldName, tombstoneVersion);

      // Old name is now a tombstone — remove from catalog
      this.catalogRemove(type, modelId, oldName);
    } catch (tombstoneError) {
      // Roll back: remove the newly created data under the new name
      logger
        .warn`Tombstone write failed during rename "${oldName}" -> "${newName}". Rolling back new data.`;
      try {
        const newVersionDir = this.getPath(
          type,
          modelId,
          newName,
          newVersion,
        );
        await Deno.remove(newVersionDir, { recursive: true });
        // If this was the only version, clean up the data name directory.
        // Otherwise, reset the latest marker to the highest remaining version
        // to avoid a corrupted marker pointing to the deleted version.
        const remaining = await this.listVersions(type, modelId, newName);
        if (remaining.length === 0) {
          const dataNameDir = this.getDataNameDir(type, modelId, newName);
          await Deno.remove(dataNameDir, { recursive: true }).catch(() => {});
        } else {
          const maxRemaining = Math.max(...remaining);
          await this.updateLatestMarker(type, modelId, newName, maxRemaining);
        }
      } catch (rollbackError) {
        logger
          .error`Rollback also failed during rename "${oldName}" -> "${newName}": ${
          String(rollbackError)
        }. Manual cleanup may be needed.`;
      }
      throw tombstoneError;
    }

    return {
      oldName,
      newName,
      copiedVersion: oldData.version,
      newVersion,
    };
  }

  async allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
  ): Promise<{ version: number; contentPath: string }> {
    // Reject reserved data names that collide with internal markers
    if (isReservedDataName(data.name)) {
      throw new Error(
        `Data name '${data.name}' is reserved for internal use. Use a different name.`,
      );
    }

    // Validate ownership if data with this name already exists
    const existing = await this.findByName(type, modelId, data.name);
    if (existing) {
      if (!existing.isOwnedBy(data.ownerDefinition)) {
        throw new OwnershipValidationError(
          data.name,
          existing.ownerDefinition,
          data.ownerDefinition,
        );
      }
    }

    // Atomically allocate a new version directory
    const { version: newVersion } = await this.atomicAllocateVersionDir(
      type,
      modelId,
      data.name,
    );

    const contentPath = this.getContentPath(
      type,
      modelId,
      data.name,
      newVersion,
    );

    return { version: newVersion, contentPath };
  }

  async finalizeVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
  ): Promise<{ size: number; checksum: string }> {
    const contentPath = this.getContentPath(
      type,
      modelId,
      data.name,
      version,
    );

    // Read content to compute size and checksum
    const content = await Deno.readFile(contentPath);
    const size = content.length;
    const checksum = await this.computeChecksum(content);

    // Create the data with updated version, size, and checksum
    const dataToSave = data.withNewVersion({
      version,
      size,
      checksum,
    });

    // Save metadata
    const metadataPath = this.getMetadataPath(
      type,
      modelId,
      data.name,
      version,
    );
    const metadata = dataToSave.toData();
    const cleanData = JSON.parse(JSON.stringify(metadata));
    const metadataContent = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(metadataPath, metadataContent);

    // Update latest symlink
    await this.updateLatestMarker(type, modelId, data.name, version);

    this.catalogUpsert(type, modelId, dataToSave);

    return { size, checksum };
  }

  nextId(): DataId {
    return generateDataId();
  }

  getPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return join(
      this.getDataNameDir(type, modelId, dataName),
      version.toString(),
    );
  }

  getContentPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return join(this.getPath(type, modelId, dataName, version), "raw");
  }

  // --- Sync read methods ---

  getLatestVersionSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number | null {
    const latestPath = join(
      this.getDataNameDir(type, modelId, dataName),
      "latest",
    );
    try {
      // Try reading as text file first (new format)
      const content = Deno.readTextFileSync(latestPath);
      const version = parseInt(content.trim(), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a text file or not found
    }
    try {
      // Backward compat: try reading as symlink (old format)
      const linkTarget = Deno.readLinkSync(latestPath);
      const version = parseInt(linkTarget.replace(/\/$/, ""), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a symlink either
    }
    // Final fallback: scan version directories
    const versions = this.listVersionsSync(type, modelId, dataName);
    return versions.length > 0 ? Math.max(...versions) : null;
  }

  findByNameSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Data | null {
    return this.findByNameSyncWithDepth(type, modelId, dataName, version, 0);
  }

  private findByNameSyncWithDepth(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number | undefined,
    depth: number,
  ): Data | null {
    const versionToRead = version ??
      this.getLatestVersionSync(type, modelId, dataName);
    if (versionToRead === null) return null;

    const metadataPath = this.getMetadataPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    try {
      const content = Deno.readTextFileSync(metadataPath);
      const metadata = parseYaml(content) as DataMetadata;
      const data = Data.fromData(metadata);

      // Follow forward references for latest lookups (not explicit version requests)
      if (version === undefined && data.isRenamed && data.renamedTo) {
        if (depth >= 5) {
          logger
            .warn`Rename chain depth exceeded for "${dataName}" (model ${modelId}). Data exists but is unreachable — simplify the rename chain.`;
          return null;
        }
        return this.findByNameSyncWithDepth(
          type,
          modelId,
          data.renamedTo,
          undefined,
          depth + 1,
        );
      }

      return data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  listVersionsSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number[] {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    const versions: number[] = [];

    try {
      for (const entry of Deno.readDirSync(dataNameDir)) {
        if (!entry.isDirectory) continue;
        if (entry.name === "latest") continue;

        const version = parseInt(entry.name, 10);
        if (!isNaN(version) && version > 0) {
          versions.push(version);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return versions.sort((a, b) => a - b);
  }

  getContentSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Uint8Array | null {
    const versionToRead = version ??
      this.getLatestVersionSync(type, modelId, dataName);
    if (versionToRead === null) return null;

    const contentPath = this.getContentPath(
      type,
      modelId,
      dataName,
      versionToRead,
    );
    try {
      return Deno.readFileSync(contentPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  findAllForModelSync(type: ModelType, modelId: string): Data[] {
    const dataDir = this.getModelDataDir(type, modelId);
    const results: Data[] = [];
    const seen = new Set<string>();

    try {
      for (const entry of Deno.readDirSync(dataDir)) {
        if (!entry.isDirectory) continue;
        const dataName = entry.name;

        const data = this.findByNameSync(type, modelId, dataName);
        if (data && !seen.has(data.name)) {
          seen.add(data.name);
          results.push(data);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results;
  }

  findAllGlobalSync(): Array<
    { data: Data; modelType: ModelType; modelId: string }
  > {
    const results: Array<
      { data: Data; modelType: ModelType; modelId: string }
    > = [];
    const baseDir = this.getBaseDir();
    this.collectAllDataSync(baseDir, [], results);
    return results;
  }

  private collectAllDataSync(
    currentDir: string,
    pathSegments: string[],
    results: Array<{ data: Data; modelType: ModelType; modelId: string }>,
  ): void {
    try {
      const entries: string[] = [];
      for (const entry of Deno.readDirSync(currentDir)) {
        if (entry.isDirectory) {
          entries.push(entry.name);
        }
      }

      for (const name of entries) {
        const childPath = join(currentDir, name);
        const childSegments = [...pathSegments, name];

        const isModelIdDir = this.isModelIdDirectorySync(childPath);

        if (isModelIdDir && childSegments.length >= 2) {
          const typeSegments = pathSegments;
          const modelId = name;
          const typeStr = typeSegments.join("/");

          try {
            const modelType = ModelType.create(typeStr);
            const dataItems = this.findAllForModelSync(modelType, modelId);
            for (const data of dataItems) {
              results.push({ data, modelType, modelId });
            }
          } catch {
            // Skip invalid model types
          }
        } else {
          this.collectAllDataSync(childPath, childSegments, results);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  private isModelIdDirectorySync(dir: string): boolean {
    try {
      for (const entry of Deno.readDirSync(dir)) {
        if (!entry.isDirectory && !entry.isSymlink) continue;
        const childPath = join(dir, entry.name);
        try {
          for (const subEntry of Deno.readDirSync(childPath)) {
            if (subEntry.isDirectory && /^\d+$/.test(subEntry.name)) {
              return true;
            }
          }
        } catch {
          // Skip unreadable directories
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return false;
  }

  async collectGarbage(
    type: ModelType,
    modelId: string,
  ): Promise<GarbageCollectionResult> {
    let versionsRemoved = 0;
    let bytesReclaimed = 0;

    const allData = await this.findAllForModel(type, modelId);

    for (const data of allData) {
      const versions = await this.listVersions(type, modelId, data.name);
      if (versions.length <= 1) continue;

      const gc = data.garbageCollection;
      let versionsToRemove: number[] = [];

      if (typeof gc === "number") {
        // Keep N most recent versions
        const toKeep = gc;
        if (versions.length > toKeep) {
          versionsToRemove = versions.slice(0, versions.length - toKeep);
        }
      } else {
        // Keep versions within duration
        const duration = this.parseDuration(gc);
        const cutoff = Date.now() - duration;

        for (const version of versions) {
          const versionData = await this.findByName(
            type,
            modelId,
            data.name,
            version,
          );
          if (versionData && versionData.createdAt.getTime() < cutoff) {
            // Don't remove if it's the only/latest version
            if (version !== Math.max(...versions)) {
              versionsToRemove.push(version);
            }
          }
        }
      }

      // Build removal tasks upfront
      const removalTasks = versionsToRemove.map((version) => ({
        contentPath: this.getContentPath(type, modelId, data.name, version),
        versionDir: this.getPath(type, modelId, data.name, version),
      }));

      // Execute in parallel batches
      const GC_BATCH_CONCURRENCY = 20;
      for (let i = 0; i < removalTasks.length; i += GC_BATCH_CONCURRENCY) {
        const batch = removalTasks.slice(i, i + GC_BATCH_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async ({ contentPath, versionDir }) => {
            let bytes = 0;
            try {
              const stat = await Deno.stat(contentPath);
              bytes = stat.size;
            } catch {
              // Ignore stat errors
            }
            try {
              await Deno.remove(versionDir, { recursive: true });
            } catch (error) {
              if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
            return bytes;
          }),
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            bytesReclaimed += result.value;
            versionsRemoved++;
          } else {
            logger
              .error`GC failed to remove version directory: ${result.reason}`;
          }
        }
      }

      // Re-scan actual versions after parallel deletions to avoid stale marker
      if (versionsToRemove.length > 0) {
        const currentVersions = await this.listVersions(
          type,
          modelId,
          data.name,
        );
        if (currentVersions.length > 0) {
          const latestVersion = Math.max(...currentVersions);
          await this.updateLatestMarker(
            type,
            modelId,
            data.name,
            latestVersion,
          );
          // Update catalog with the surviving latest version
          const latestData = await this.findByName(
            type,
            modelId,
            data.name,
            latestVersion,
          );
          if (latestData) {
            this.catalogUpsert(type, modelId, latestData);
          }
        } else {
          const dataNameDir = this.getDataNameDir(type, modelId, data.name);
          await Deno.remove(dataNameDir, { recursive: true }).catch(() => {});
          this.catalogRemove(type, modelId, data.name);
        }
      }
    }

    return { versionsRemoved, bytesReclaimed };
  }

  private getBaseDir(): string {
    return this.baseDir;
  }

  private getTypeDir(type: ModelType): string {
    return join(this.getBaseDir(), type.toDirectoryPath());
  }

  private getModelDataDir(type: ModelType, modelId: string): string {
    const typeDir = this.getTypeDir(type);
    const result = join(typeDir, modelId);
    this.assertPathContained(result, typeDir, `modelId "${modelId}"`);
    return result;
  }

  getDataNameDir(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): string {
    const modelDir = this.getModelDataDir(type, modelId);
    const result = join(modelDir, dataName);
    this.assertPathContained(result, modelDir, `dataName "${dataName}"`);
    return result;
  }

  /**
   * Atomically allocates a new version directory using mkdir as a claim mechanism.
   * On collision (AlreadyExists), increments the version and retries.
   */
  private async atomicAllocateVersionDir(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<{ version: number; versionDir: string }> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    await assertSafePath(dataNameDir, this.baseDir);
    await Deno.mkdir(dataNameDir, { recursive: true });

    const versions = await this.listVersions(type, modelId, dataName);
    let nextVersion = versions.length > 0 ? Math.max(...versions) + 1 : 1;

    const maxRetries = 100;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const versionDir = this.getPath(type, modelId, dataName, nextVersion);
      try {
        await Deno.mkdir(versionDir);
        return { version: nextVersion, versionDir };
      } catch (error) {
        if (error instanceof Deno.errors.AlreadyExists) {
          nextVersion++;
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Failed to allocate version for "${dataName}" after ${maxRetries} retries`,
    );
  }

  private assertPathContained(
    path: string,
    expectedParent: string,
    context: string,
  ): void {
    const resolvedPath = resolve(path);
    const resolvedParent = resolve(expectedParent);
    if (
      resolvedPath !== resolvedParent &&
      !resolvedPath.startsWith(resolvedParent + "/")
    ) {
      throw new Error(
        `Path traversal detected: ${context} resolves outside expected directory`,
      );
    }
  }

  getMetadataPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string {
    return join(
      this.getPath(type, modelId, dataName, version),
      "metadata.yaml",
    );
  }

  private async getLatestVersion(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number | null> {
    const latestPath = join(
      this.getDataNameDir(type, modelId, dataName),
      "latest",
    );
    try {
      // Try reading as a text file first (new format)
      const content = await Deno.readTextFile(latestPath);
      const version = parseInt(content.trim(), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a text file or not found
    }
    try {
      // Backward compat: try reading as a symlink (old format)
      const linkTarget = await Deno.readLink(latestPath);
      const version = parseInt(linkTarget.replace(/\/$/, ""), 10);
      if (!isNaN(version)) return version;
    } catch {
      // Not a symlink either
    }
    // Final fallback: scan version directories
    const versions = await this.listVersions(type, modelId, dataName);
    return versions.length > 0 ? Math.max(...versions) : null;
  }

  private async updateLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<void> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    await assertSafePath(dataNameDir, this.baseDir);
    const latestPath = join(dataNameDir, "latest");

    // Remove old symlink or file if it exists
    try {
      await Deno.remove(latestPath);
    } catch {
      // Ignore if not found
    }

    // Write version number as plain text
    await atomicWriteTextFile(latestPath, version.toString());
  }

  private async computeChecksum(content: Uint8Array): Promise<string> {
    const buffer = new ArrayBuffer(content.length);
    new Uint8Array(buffer).set(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)(mo|y|h|m|d|w)$/);
    if (!match) {
      throw new Error(`Invalid duration format: ${duration}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "mo":
        return value * 30 * 24 * 60 * 60 * 1000;
      case "y":
        return value * 365 * 24 * 60 * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "m":
        return value * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      case "w":
        return value * 7 * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unknown duration unit: ${unit}`);
    }
  }
}

/**
 * Creates an OwnerDefinition for a model method.
 */
export function createModelMethodOwner(
  modelType: string,
  methodName: string,
  workflowId?: string,
  workflowRunId?: string,
): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: `${modelType}:${methodName}`,
    workflowId,
    workflowRunId,
  };
}

/**
 * Creates an OwnerDefinition for a workflow step.
 */
export function createWorkflowStepOwner(
  workflowId: string,
  jobName: string,
  stepName: string,
  workflowRunId?: string,
): OwnerDefinition {
  return {
    ownerType: "workflow-step",
    ownerRef: `${workflowId}:${jobName}:${stepName}`,
    workflowId,
    workflowRunId,
  };
}

/**
 * Creates an OwnerDefinition for manual data creation.
 */
export function createManualOwner(
  description: string,
): OwnerDefinition {
  return {
    ownerType: "manual",
    ownerRef: description,
  };
}
