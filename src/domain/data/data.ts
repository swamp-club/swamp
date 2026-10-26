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

import { createDataId, type DataId, generateDataId } from "./data_id.ts";
import {
  type DataLifecycle,
  type DataMetadata,
  DataMetadataSchema,
  type GarbageCollectionPolicy,
  type Lifetime,
  normalizeLifetime,
  type OwnerDefinition,
} from "./data_metadata.ts";

/**
 * Names reserved for internal use within data storage directories.
 * These cannot be used as user-supplied data names because they collide
 * with internal markers (e.g. the "latest" version pointer file).
 */
export const RESERVED_DATA_NAMES: ReadonlyArray<string> = ["latest"];

/**
 * Returns true if the given name is reserved for internal use.
 * Comparison is case-insensitive because some filesystems (e.g. macOS HFS+)
 * are case-insensitive.
 */
export function isReservedDataName(name: string): boolean {
  return RESERVED_DATA_NAMES.includes(name.toLowerCase());
}

/**
 * Prefix of the tag keys swamp writes itself, such as the
 * `_swamp.sensitiveFields` tag the data writer sets after vaulting and the
 * `_swamp.kind` tag it stamps on every record. A key under it is never
 * accepted from a definition, spec, method, workflow or `--tag`
 * (swamp-club#3635): readers trust these tags as swamp's own.
 */
export const RESERVED_TAG_PREFIX = "_swamp.";

/**
 * Tag keys outside {@link RESERVED_TAG_PREFIX} that the data writers set
 * themselves and readers trust: `specName` names the spec that wrote a
 * record, and the resource reader once chose which fields resolve vault
 * references by it (swamp-club#3684). Refused from every user source, like a
 * key under the prefix.
 */
export const RESERVED_TAG_KEYS: readonly string[] = ["specName"];

/**
 * Returns true if the tag key is reserved for swamp. Comparison is
 * case-sensitive: readers look reserved tags up by their exact key, so a
 * case variant is an ordinary tag.
 */
export function isReservedTagKey(key: string): boolean {
  return key.startsWith(RESERVED_TAG_PREFIX) || RESERVED_TAG_KEYS.includes(key);
}

/** Returns the first reserved key in `tags`, or undefined when there is none. */
export function findReservedTagKey(
  tags: Record<string, string>,
): string | undefined {
  return Object.keys(tags).find(isReservedTagKey);
}

/**
 * Printable characters the Windows file API rejects in a file name; it also
 * rejects the control characters U+0001 to U+001F.
 */
const WINDOWS_FORBIDDEN_CHARACTERS = '<>:"|?*';

/** Device names Windows reserves, alone or followed by an extension. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Whether a data name can be stored as a file name on every platform
 * (swamp-club#3568). `problem` completes the sentence "Data name 'x' ...".
 */
export type DataNamePortability =
  | { kind: "ok" }
  | { kind: "warn" | "refuse"; problem: string };

/**
 * Checks a data name against Windows file-name rules, since the filesystem
 * datastore stores each data name as a directory name.
 *
 * A character the Windows file API rejects is refused on Windows, where the
 * write would fail anyway, and warned about elsewhere so an author on Linux
 * or macOS sees it. A reserved device name or a trailing dot or space is only
 * warned about, on every platform: Windows may strip or accept these, so
 * refusing them could break a write that works today. The name is never
 * changed, so nothing already stored moves.
 */
export function dataNamePortability(
  name: string,
  os: typeof Deno.build.os,
): DataNamePortability {
  const forbidden = [...name].find((c) =>
    WINDOWS_FORBIDDEN_CHARACTERS.includes(c) || (c > "\0" && c < " ")
  );
  if (forbidden !== undefined) {
    const shown = forbidden < " "
      ? `the control character U+${
        forbidden.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
      }`
      : `'${forbidden}'`;
    return {
      kind: os === "windows" ? "refuse" : "warn",
      problem: `contains ${shown}, which Windows does not allow in file names`,
    };
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    return { kind: "warn", problem: "is a device name Windows reserves" };
  }
  if (name.endsWith(".")) {
    return {
      kind: "warn",
      problem: "ends with a dot, which Windows drops from file names",
    };
  }
  if (name.endsWith(" ")) {
    return {
      kind: "warn",
      problem: "ends with a space, which Windows drops from file names",
    };
  }
  return { kind: "ok" };
}

/**
 * Properties required to create a new Data entity.
 */
export interface CreateDataProps {
  name: string;
  id?: string;
  version?: number;
  contentType: string;
  lifetime: Lifetime;
  garbageCollection: GarbageCollectionPolicy;
  streaming?: boolean;
  tags: Record<string, string>;
  ownerDefinition: OwnerDefinition;
  createdAt?: Date;
  size?: number;
  checksum?: string;
  lifecycle?: DataLifecycle;
  renamedTo?: string;
}

/**
 * Data is a unified entity representing versioned data storage.
 *
 * Each Data entity has:
 * - A unique ID (UUID)
 * - A human-readable name
 * - Version tracking
 * - Content type (MIME type)
 * - Lifetime policy for automatic cleanup
 * - Garbage collection policy for version retention
 * - Streaming flag for append-only data
 * - Tags including a required 'type' key
 * - Owner definition for access control
 */
export class Data {
  private constructor(
    readonly id: DataId,
    readonly name: string,
    readonly version: number,
    readonly contentType: string,
    readonly lifetime: Lifetime,
    readonly garbageCollection: GarbageCollectionPolicy,
    readonly streaming: boolean,
    readonly tags: Record<string, string>,
    readonly ownerDefinition: OwnerDefinition,
    readonly createdAt: Date,
    readonly lifecycle: DataLifecycle,
    readonly size?: number,
    readonly checksum?: string,
    readonly renamedTo?: string,
  ) {}

  /**
   * Creates a new Data instance.
   *
   * @param props - Properties for the new data entity
   * @returns A new Data instance
   * @throws ZodError if validation fails
   */
  static create(props: CreateDataProps): Data {
    const id = props.id ?? generateDataId();
    const version = props.version ?? 1;
    const createdAt = props.createdAt ?? new Date();
    const lifetime = normalizeLifetime(props.lifetime);
    const lifecycle = props.lifecycle ?? "active";

    const validated = DataMetadataSchema.parse({
      id,
      name: props.name,
      version,
      contentType: props.contentType,
      lifetime,
      garbageCollection: props.garbageCollection,
      streaming: props.streaming ?? false,
      tags: props.tags,
      ownerDefinition: props.ownerDefinition,
      createdAt: createdAt.toISOString(),
      size: props.size,
      checksum: props.checksum,
      lifecycle: lifecycle === "active" ? undefined : lifecycle,
      renamedTo: props.renamedTo,
    });

    return new Data(
      createDataId(validated.id),
      validated.name,
      validated.version,
      validated.contentType,
      validated.lifetime,
      validated.garbageCollection,
      validated.streaming,
      { ...validated.tags },
      { ...validated.ownerDefinition },
      new Date(validated.createdAt),
      validated.lifecycle ?? "active",
      validated.size,
      validated.checksum,
      validated.renamedTo,
    );
  }

  /**
   * Reconstructs a Data entity from persisted metadata.
   *
   * @param data - The persisted metadata
   * @returns A Data instance
   * @throws ZodError if validation fails
   */
  static fromData(data: DataMetadata): Data {
    const validated = DataMetadataSchema.parse({
      ...data,
      lifetime: normalizeLifetime(data.lifetime),
    });
    return new Data(
      createDataId(validated.id),
      validated.name,
      validated.version,
      validated.contentType,
      validated.lifetime,
      validated.garbageCollection,
      validated.streaming,
      { ...validated.tags },
      { ...validated.ownerDefinition },
      new Date(validated.createdAt),
      validated.lifecycle ?? "active",
      validated.size,
      validated.checksum,
      validated.renamedTo,
    );
  }

  /**
   * Converts the Data entity to a plain data object for persistence.
   */
  toData(): DataMetadata {
    const data: DataMetadata = {
      id: this.id,
      name: this.name,
      version: this.version,
      contentType: this.contentType,
      lifetime: this.lifetime,
      garbageCollection: this.garbageCollection,
      streaming: this.streaming,
      tags: { ...this.tags },
      ownerDefinition: { ...this.ownerDefinition },
      createdAt: this.createdAt.toISOString(),
    };

    if (this.size !== undefined) {
      data.size = this.size;
    }
    if (this.checksum !== undefined) {
      data.checksum = this.checksum;
    }
    if (this.lifecycle === "deleted") {
      data.lifecycle = "deleted";
    }
    if (this.renamedTo !== undefined) {
      data.renamedTo = this.renamedTo;
    }

    return data;
  }

  /**
   * Checks if this data is owned by the given owner definition.
   * Ownership is verified by comparing ownerType and ownerRef.
   *
   * @param definition - The owner definition to check
   * @returns true if the ownerType and ownerRef match
   */
  isOwnedBy(definition: OwnerDefinition): boolean {
    return this.ownerDefinition.ownerType === definition.ownerType &&
      this.ownerDefinition.ownerRef === definition.ownerRef;
  }

  /**
   * Gets the type tag value.
   */
  get type(): string {
    return this.tags.type;
  }

  /**
   * Returns true if this data has been marked as deleted.
   */
  get isDeleted(): boolean {
    return this.lifecycle === "deleted";
  }

  /**
   * Returns true if this data has been renamed (tombstoned with a forward reference).
   */
  get isRenamed(): boolean {
    return this.lifecycle === "deleted" && this.renamedTo !== undefined;
  }

  /**
   * Creates a deletion marker version of this data.
   * The marker has lifecycle "deleted", JSON content type, and streaming disabled.
   */
  withDeletionMarker(props: { version: number }): Data {
    return Data.create({
      id: this.id,
      name: this.name,
      version: props.version,
      contentType: "application/json",
      lifetime: this.lifetime,
      garbageCollection: this.garbageCollection,
      streaming: false,
      tags: this.tags,
      ownerDefinition: this.ownerDefinition,
      lifecycle: "deleted",
    });
  }

  /**
   * Creates a rename marker version of this data.
   * The marker has lifecycle "deleted" and a forward reference to the new name.
   */
  withRenameMarker(props: { version: number; renamedTo: string }): Data {
    return Data.create({
      id: this.id,
      name: this.name,
      version: props.version,
      contentType: "application/json",
      lifetime: this.lifetime,
      garbageCollection: this.garbageCollection,
      streaming: false,
      tags: this.tags,
      ownerDefinition: this.ownerDefinition,
      lifecycle: "deleted",
      renamedTo: props.renamedTo,
    });
  }

  /**
   * Creates a new version of this data with updated properties.
   * The new version inherits most properties from the current version.
   */
  withNewVersion(props: {
    version: number;
    createdAt?: Date;
    size?: number;
    checksum?: string;
  }): Data {
    return Data.create({
      id: this.id,
      name: this.name,
      version: props.version,
      contentType: this.contentType,
      lifetime: this.lifetime,
      garbageCollection: this.garbageCollection,
      streaming: this.streaming,
      tags: this.tags,
      ownerDefinition: this.ownerDefinition,
      createdAt: props.createdAt ?? new Date(),
      size: props.size,
      checksum: props.checksum,
      lifecycle: this.lifecycle,
      renamedTo: this.renamedTo,
    });
  }
}
