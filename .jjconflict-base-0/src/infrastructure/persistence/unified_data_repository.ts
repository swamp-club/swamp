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

import { join, relative, resolve } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { atomicWriteFile, atomicWriteTextFile } from "./atomic_write.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import {
  Data,
  type DataId,
  type DataMetadata,
  generateDataId,
  type OwnerDefinition,
} from "../../domain/data/mod.ts";
import { ModelType } from "../../domain/models/model_type.ts";

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
  removeLatestSymlink(
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
  constructor(private readonly repoDir: string) {}

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

  async findByName(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
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
      return Data.fromData(metadata);
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

    try {
      for await (const entry of Deno.readDir(dataDir)) {
        if (!entry.isDirectory) continue;
        const dataName = entry.name;

        const data = await this.findByName(type, modelId, dataName);
        if (data) {
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
    await atomicWriteFile(contentPath, content);

    // Update latest symlink
    await this.updateLatestSymlink(type, modelId, data.name, newVersion);

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
        await this.updateLatestSymlink(type, modelId, dataName, newLatest);
      } else {
        // No versions left, remove the data name directory
        const dataNameDir = this.getDataNameDir(type, modelId, dataName);
        await Deno.remove(dataNameDir, { recursive: true }).catch(() => {});
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
    }
  }

  /**
   * Removes the latest symlink for expired data (soft delete).
   * Version directories remain on disk but data becomes inaccessible.
   */
  async removeLatestSymlink(
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
  }

  async allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
  ): Promise<{ version: number; contentPath: string }> {
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
    await this.updateLatestSymlink(type, modelId, data.name, version);

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

      for (const version of versionsToRemove) {
        const contentPath = this.getContentPath(
          type,
          modelId,
          data.name,
          version,
        );
        try {
          const stat = await Deno.stat(contentPath);
          bytesReclaimed += stat.size;
        } catch {
          // Ignore stat errors
        }

        await this.delete(type, modelId, data.name, version);
        versionsRemoved++;
      }
    }

    return { versionsRemoved, bytesReclaimed };
  }

  private getBaseDir(): string {
    return swampPath(this.repoDir, SWAMP_SUBDIRS.data);
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

  private getDataNameDir(
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

  private getMetadataPath(
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
      const linkTarget = await Deno.readLink(latestPath);
      const version = parseInt(linkTarget.replace(/\/$/, ""), 10);
      return isNaN(version) ? null : version;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Fall back to scanning versions
        const versions = await this.listVersions(type, modelId, dataName);
        return versions.length > 0 ? Math.max(...versions) : null;
      }
      throw error;
    }
  }

  private async updateLatestSymlink(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<void> {
    const dataNameDir = this.getDataNameDir(type, modelId, dataName);
    const latestPath = join(dataNameDir, "latest");
    const target = version.toString();

    // Use relative path for symlink
    const relativeTarget = relative(dataNameDir, join(dataNameDir, target));

    // Create temp symlink and atomically rename
    const tempPath = `${latestPath}.tmp.${crypto.randomUUID()}`;

    try {
      await Deno.symlink(relativeTarget, tempPath, { type: "dir" });
      await Deno.rename(tempPath, latestPath);
    } catch (error) {
      // Clean up temp symlink on failure
      try {
        await Deno.remove(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
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
