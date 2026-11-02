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

export type ContentAvailability = "current" | "acceptedShort" | "missing";

/**
 * reads from the remote datastore on v2, from the namespace's cache root in the
 * checkout on v3; null when the file does not exist, and nothing is written to
 * local storage
 */
export type ForeignContentFetcher =
  & ((
    namespace: string,
    relPath: string,
  ) => Promise<Uint8Array | null>)
  & {
    /**
     * reads the solo namespace too, so a solo row in a namespaced repository is
     * another namespace's (v3); otherwise it is the repository's own and never
     * fetched
     */
    readonly readsSoloNamespace?: boolean;
  };

/**
 * a foreign row's content is never in the repository's own layout and is read
 * only through the fetcher; a solo row is own unless the fetcher reads the solo
 * namespace
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

export interface GarbageCollectionResult {
  versionsRemoved: number;
  bytesReclaimed: number;
}

export interface DeferredWriteReceipt {
  readonly type: ModelType;
  readonly modelId: string;
  readonly dataName: string;
  readonly version: number;
}

export interface RenameForward {
  modelType: ModelType;
  modelId: string;
  dataName: string;
  renamedTo: string;
}

export interface FindAllGlobalOptions {
  renames?: RenameForward[];
}

export interface UnreadableModelRecord {
  modelType: ModelType;
  modelId: string;
  dataName?: string;
  error: unknown;
}

export interface FindAllForTypeOptions {
  unreadable?: UnreadableModelRecord[];
}

export interface AgedDataVersion {
  type: ModelType;
  modelId: string;
  dataName: string;
  version: number;
  createdAt: Date;
  size: number;
}

export interface AgedDataVersionPage {
  versions: AgedDataVersion[];
  cursor?: string;
}

export interface FindVersionsCreatedBeforeOptions {
  limit: number;
  cursor?: string;
  excludeTypes?: readonly string[];
}

export interface UnifiedDataRepository {
  /**
   * catalog rows this repository produces, at runtime and in backfill, are
   * stamped with it; SOLO_NAMESPACE ('') in solo mode
   */
  readonly namespace: Namespace;

  /**
   * not scoped to namespace and never touches local storage; absent when the
   * datastore has no remote to read from
   */
  readonly fetchForeignContent?: ForeignContentFetcher;

  findAllGlobal(options?: FindAllGlobalOptions): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;

  findAllForType(
    type: ModelTypeInput,
    options?: FindAllForTypeOptions,
  ): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;

  findByName(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Data | null>;

  findById(
    type: ModelType,
    modelId: string,
    dataId: DataId,
    version?: number,
  ): Promise<Data | null>;

  listVersions(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<number[]>;

  findAllForModel(type: ModelTypeInput, modelId: string): Promise<Data[]>;

  /**
   * reads each data name only when the consumer asks for it, so a caller that
   * stops early does not pay for the rest
   */
  iterateForModel(type: ModelTypeInput, modelId: string): AsyncIterable<Data>;

  save(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<{ version: number; checksum?: string }>;

  append(
    type: ModelType,
    modelId: string,
    dataName: string,
    content: Uint8Array,
  ): Promise<void>;

  stream(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): AsyncIterable<Uint8Array>;

  getContent(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;

  /**
   * a lazily hydrating cache can hold metadata without content, or older
   * content; a missing or short file is downloaded via the hydrate hook.
   * acceptedShort: still short after a refresh, so the remote's is short too
   */
  ensureContentLocal(
    type: ModelTypeInput,
    modelId: string,
    dataName: string,
    version?: number,
    knownSize?: number,
  ): Promise<ContentAvailability>;

  /**
   * true when the file is not shorter than size, or a recent refresh found the
   * remote's copy short too; always true when the repository cannot hydrate,
   * since nothing would replace the file
   */
  isContentAcceptedSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
    size: number,
  ): boolean;

  delete(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<void>;

  /**
   * soft delete: version directories remain on disk but the data becomes
   * inaccessible
   */
  removeLatestMarker(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<void>;

  /**
   * deferred registers the version as pending before any content is written;
   * durable means content written through the caller's own handle is synced on
   * it before finalizing, via syncContent when set
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
      syncContent?: (file: Deno.FsFile) => Promise<void>;
    }
  >;

  /**
   * contentSynced means the caller synced content on the handle that wrote it;
   * otherwise a durable repository syncs it before publishing the version
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
   * inserts a catalog row with both latest flags 0, so the data is invisible to
   * latest-based reads until advanceLatestMarkers is called
   */
  saveDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    content: Uint8Array,
  ): Promise<DeferredWriteReceipt>;

  finalizeVersionDeferred(
    type: ModelType,
    modelId: string,
    data: Data,
    version: number,
    priorVersions?: number[],
    options?: { contentSynced?: boolean },
  ): Promise<{ receipt: DeferredWriteReceipt; size: number; checksum: string }>;

  /**
   * partial failure is tolerated: one failed marker is logged and the rest
   * continue
   */
  advanceLatestMarkers(receipts: DeferredWriteReceipt[]): Promise<void>;

  rollbackVersions(receipts: DeferredWriteReceipt[]): Promise<void>;

  nextId(): DataId;

  getPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string;

  getContentPath(
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ): string;

  collectGarbage(
    type: ModelType,
    modelId: string,
    options?: { dryRun?: boolean },
  ): Promise<GarbageCollectionResult>;

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

  getLatestVersionSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number | null;

  findByNameSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Data | null;

  listVersionsSync(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): number[];

  getContentSync(
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Uint8Array | null;

  findAllForModelSync(type: ModelType, modelId: string): Data[];

  findAllGlobalSync(options?: FindAllGlobalOptions): Array<
    { data: Data; modelType: ModelType; modelId: string }
  >;

  /**
   * a name whose latest version is a deletion marker is returned (it is a
   * catalog row); a rename marker is not
   */
  findByTaggedName(
    modelName: string,
    dataName: string,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>>;

  /**
   * in-flight deferred writes are never listed; absent when the repository
   * cannot list by age
   */
  /**
   * later writes allocate above version so numbers never go back once retention
   * deletes the newest versions; optional, absent means numbers may be reused
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
   * a version written but not yet promoted or rolled back; deleting the name
   * would lose it
   */
  hasPendingVersions?(
    type: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<boolean>;
}
