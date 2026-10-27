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
import { isForeignToReader, type Namespace } from "./namespace.ts";

/**
 * Whether a version's content file can be read as current, from
 * {@link UnifiedDataRepository.ensureContentLocal}.
 */
export type ContentAvailability = "current" | "acceptedShort" | "missing";

/**
 * Reads one file of another namespace, by its path relative to that
 * namespace's root: from the remote datastore on v2, from the namespace's
 * cache root in the checkout on v3. Returns the bytes, or null when the file
 * does not exist. Nothing is written to local storage.
 */
export type ForeignContentFetcher =
  & ((
    namespace: string,
    relPath: string,
  ) => Promise<Uint8Array | null>)
  & {
    /**
     * The fetcher reads the solo namespace (`""`) too, so a row of it in a
     * namespaced repository is another namespace's row (v3, swamp-club#3691).
     * Otherwise such a row is the repository's own, written before it set a
     * namespace, and is never fetched.
     */
    readonly readsSoloNamespace?: boolean;
  };

/**
 * Whether a row of `namespace` is another namespace's to the repository
 * `repo`: its content is never in the repository's own layout, and is read
 * only through {@link ForeignContentFetcher}. A solo row (`""`) is the
 * repository's own unless its fetcher reads the solo namespace.
 */
export function isForeignNamespace(
  namespace: string,
  repo: {
    readonly namespace: string;
    readonly fetchForeignContent?: ForeignContentFetcher;
  },
): boolean {
  return isForeignToReader(namespace, {
    namespace: repo.namespace,
    readsSoloNamespace: repo.fetchForeignContent?.readsSoloNamespace === true,
  });
}

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
 * Error thrown when the ephemeral data memory budget is exceeded.
 */
export class EphemeralBudgetExceededError extends Error {
  constructor(
    readonly currentBytes: number,
    readonly contentBytes: number,
    readonly maxBytes: number,
  ) {
    const usedMB = Math.round(currentBytes / 1024 / 1024);
    const maxMB = Math.round(maxBytes / 1024 / 1024);
    super(
      `Ephemeral data budget exceeded: ${usedMB} MB used, ` +
        `write of ${contentBytes} bytes would exceed ${maxMB} MB limit. ` +
        `Use "workflow" or "infinite" lifetime for large data.`,
    );
    this.name = "EphemeralBudgetExceededError";
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
 * Receipt for a deferred write — enough information to commit or roll back.
 */
export interface DeferredWriteReceipt {
  readonly type: ModelType;
  readonly modelId: string;
  readonly dataName: string;
  readonly version: number;
}

/**
 * A rename marker found while walking the data tree: `dataName` was renamed
 * to `renamedTo` under the same model.
 */
export interface RenameForward {
  modelType: ModelType;
  modelId: string;
  dataName: string;
  renamedTo: string;
}

/** Options for {@link UnifiedDataRepository.findAllGlobal}. */
export interface FindAllGlobalOptions {
  /**
   * Receives every rename marker the walk follows past, so catalog backfill
   * can record rename forwards without walking the tree a second time.
   */
  renames?: RenameForward[];
}

/**
 * A model whose data exists but could not be read: a directory or file the
 * process may not read, or metadata that does not parse (swamp-club#3386).
 */
export interface UnreadableModelRecord {
  modelType: ModelType;
  modelId: string;
  /**
   * The data name that could not be read; absent when the model directory
   * itself could not be.
   */
  dataName?: string;
  error: unknown;
}

/** Options for {@link UnifiedDataRepository.findAllForType}. */
export interface FindAllForTypeOptions {
  /**
   * Receives every model the scan skipped because its data could not be
   * read, so a caller can tell an unreadable record from a missing one.
   */
  unreadable?: UnreadableModelRecord[];
}

/**
 * A stored version created before a retention cutoff
 * (see {@link UnifiedDataRepository.findVersionsCreatedBefore}).
 */
export interface AgedDataVersion {
  type: ModelType;
  modelId: string;
  dataName: string;
  version: number;
  createdAt: Date;
  /** Content size in bytes, as recorded when the version was written. */
  size: number;
}

/** One page of {@link AgedDataVersion}s, oldest first. */
export interface AgedDataVersionPage {
  versions: AgedDataVersion[];
  /** Pass back to read the next page; absent on the last page. */
  cursor?: string;
}

/** Options for {@link UnifiedDataRepository.findVersionsCreatedBefore}. */
export interface FindVersionsCreatedBeforeOptions {
  /** Most versions to return in this page. */
  limit: number;
  /** The previous page's cursor. */
  cursor?: string;
  /** Normalized model types to leave out. */
  excludeTypes?: readonly string[];
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
   * Reads the content behind a catalog row of another namespace, which this
   * repository's own layout never holds. Unlike every other read here it is
   * not scoped to {@link namespace} and never touches local storage. Absent
   * when the datastore has no remote to read from (swamp-club#3306).
   */
  readonly fetchForeignContent?: ForeignContentFetcher;

  /**
   * Finds all data across all model types and models.
   *
   * @returns Array of data with their model type and model ID
   */
  findAllGlobal(options?: FindAllGlobalOptions): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;

  /**
   * Finds all data for a single model type across all models of that type.
   *
   * @param type - The model type to scan
   * @param options - Optional collector for models that could not be read
   * @returns Array of data with their model type and model ID
   */
  findAllForType(
    type: ModelTypeInput,
    options?: FindAllForTypeOptions,
  ): Promise<
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
   * Yields the same data as {@link findAllForModel}, in the same order, but
   * reads each data name only when the consumer asks for it, so a caller
   * that stops early does not pay for the rest of the model's data.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @returns The latest data of each name, read lazily
   */
  iterateForModel(type: ModelTypeInput, modelId: string): AsyncIterable<Data>;

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
  ): Promise<{ version: number; checksum?: string }>;

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
   * Makes a version's content file local and current before a caller reads
   * it. On a datastore that hydrates lazily the cache can hold a version's
   * metadata without its content, or content older than the metadata (a
   * metadata-only pull after another host appended to it). A missing file,
   * or one shorter than the size its metadata records, is downloaded through
   * the repository's hydrate hook.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param dataName - The data name
   * @param version - Optional version (defaults to latest)
   * @param knownSize - The recorded size, when the caller already holds it
   * @returns `current` when the file is present and not shorter than its
   *   recorded size (always, when the repository cannot hydrate);
   *   `acceptedShort` when it is still shorter after a refresh, so the
   *   remote's copy is short too; `missing` when there is no file
   */
  ensureContentLocal(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
    knownSize?: number,
  ): Promise<ContentAvailability>;

  /**
   * Whether a synchronous reader may use the local content file of a
   * version whose recorded size is `size`: the file is not shorter than
   * that, or a recent refresh found the remote's copy short too (so
   * {@link getContent} returns the same bytes). Always true when the
   * repository cannot hydrate, since then nothing would replace the file.
   */
  isContentAcceptedSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    size: number,
  ): boolean;

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
   * Removes the latest marker for expired data (soft delete).
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
   * @param options.deferred - The version is a deferred write: register it
   *   as pending (not promoted) before any content is written.
   *   finalizeVersionDeferred completes the pending row and
   *   advanceLatestMarkers or rollbackVersions settles it; if registering
   *   fails, the allocated version is removed before the error is thrown
   * @returns The allocated version number and content file path. `durable`
   *   is a write-handling instruction (swamp-club#4017): when true, content
   *   the caller writes to `contentPath` through a handle of its own is
   *   synced on that handle before finalizing, and finalize is told so.
   *   Absent means false.
   */
  allocateVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    options?: { deferred?: boolean },
  ): Promise<
    {
      version: number;
      contentPath: string;
      priorVersions: number[];
      durable?: boolean;
    }
  >;

  /**
   * Finalizes a previously allocated version by writing metadata and updating symlinks.
   * Content must already exist on disk at the content path.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param data - The data entity
   * @param version - The version number to finalize
   * @param priorVersions - Versions that existed before allocation (for write-time GC)
   * @param options.contentSynced - The caller synced the content on the
   *   handle that wrote it (see allocateVersion's `durable`); otherwise a
   *   durable repository syncs it before publishing the version
   * @returns Size and checksum of the content
   */
  finalizeVersion(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
    options?: { contentSynced?: boolean },
  ): Promise<{ size: number; checksum: string }>;

  /**
   * Saves data without advancing the latest marker. Writes the version
   * directory, content, and metadata to disk, and inserts a catalog row
   * with both latest flags 0. The data is invisible to latest-based reads until
   * advanceLatestMarkers() is called.
   *
   * @returns A receipt that can be passed to advanceLatestMarkers or rollbackVersions
   */
  saveDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<DeferredWriteReceipt>;

  /**
   * Finalizes a previously allocated version without advancing the latest
   * marker. Mirrors finalizeVersion but writes the catalog row with both
   * latest flags 0. `options.contentSynced` is as for finalizeVersion.
   *
   * @returns A receipt plus size and checksum
   */
  finalizeVersionDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
    options?: { contentSynced?: boolean },
  ): Promise<{ receipt: DeferredWriteReceipt; size: number; checksum: string }>;

  /**
   * Commits deferred writes by advancing the latest marker and promoting
   * each receipt's catalog row (see CatalogStore.upsertNewVersion). Handles partial failure
   * gracefully — logs and continues if one marker fails.
   */
  advanceLatestMarkers(receipts: DeferredWriteReceipt[]): Promise<void>;

  /**
   * Rolls back deferred writes by deleting version directories and removing
   * catalog rows for each receipt.
   */
  rollbackVersions(receipts: DeferredWriteReceipt[]): Promise<void>;

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
  findAllGlobalSync(options?: FindAllGlobalOptions): Array<
    { data: Data; modelType: ModelType; modelId: string }
  >;

  /**
   * Finds data matching a specific (modelName, dataName) pair by walking
   * the filesystem and checking metadata tags. Used for scoped catalog
   * backfill when the catalog is not yet populated but only a single
   * data item is needed. A name whose latest version is a deletion marker
   * is returned (it is a catalog row); a rename marker is not.
   *
   * @param modelName - The modelName tag value to match
   * @param dataName - The data directory name to match
   * @returns Array of matching data with their model type and model ID
   */
  findByTaggedName(
    modelName: string,
    dataName: string,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>>;

  /**
   * Lists promoted versions of this repository's namespace created before
   * `cutoff`, oldest first and a page at a time, from an index on creation
   * time rather than a walk of every data item. In-flight deferred writes
   * are never listed. Data retention reads its candidates here. Absent when
   * the repository cannot list by age.
   */
  /**
   * Keeps a name's version numbers from going back once retention has
   * deleted its newest versions (swamp-club#3473): later writes allocate
   * above `version`. Optional; absent, numbers may be reused.
   */
  raiseVersionFloor?(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): Promise<void>;

  findVersionsCreatedBefore?(
    cutoff: Date,
    options: FindVersionsCreatedBeforeOptions,
  ): Promise<AgedDataVersionPage>;

  /**
   * Whether a data name has an in-flight deferred write: a version written
   * but not yet promoted or rolled back. Deleting the name would lose it.
   */
  hasPendingVersions?(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<boolean>;
}
