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
 * cannot be user-supplied data names because they collide with internal markers
 * such as the latest version pointer file
 */
export const RESERVED_DATA_NAMES: ReadonlyArray<string> = ["latest"];

/** case-insensitive because some filesystems, such as macOS HFS+, are */
export function isReservedDataName(name: string): boolean {
  return RESERVED_DATA_NAMES.includes(name.toLowerCase());
}

/**
 * prefix of tag keys swamp writes itself; a key under it is never accepted from
 * a definition, spec, method, workflow or --tag, because readers trust these
 * tags as swamp's own
 */
export const RESERVED_TAG_PREFIX = "_swamp.";

/**
 * carried by a version an offline flush wrote only to keep the current latest's
 * content highest; it holds the number of the version it restates, never a time
 */
export const RESTATES_TAG = `${RESERVED_TAG_PREFIX}restates`;

/**
 * stamped by both writers after every override and under the reserved prefix,
 * so no user source sets it; records without it keep the schema fallback in
 * getSensitiveFieldsForResolution and the type tag in dataKindOf
 */
export const RECORD_KIND_TAG = `${RESERVED_TAG_PREFIX}kind`;

/**
 * tag keys outside the prefix that data writers set and readers trust, such as
 * specName; refused from every user source like a key under the prefix
 */
export const RESERVED_TAG_KEYS: readonly string[] = ["specName"];

/**
 * case-sensitive: readers look reserved tags up by exact key, so a case variant
 * is an ordinary tag
 */
export function isReservedTagKey(key: string): boolean {
  return key.startsWith(RESERVED_TAG_PREFIX) || RESERVED_TAG_KEYS.includes(key);
}

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

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type DataNamePortability =
  | { kind: "ok" }
  | { kind: "warn" | "refuse"; problem: string };

/**
 * a forbidden character is refused on Windows and warned elsewhere; a reserved
 * device name or trailing dot or space is only warned about, as Windows may
 * accept them; the name is never changed
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

  isOwnedBy(definition: OwnerDefinition): boolean {
    return this.ownerDefinition.ownerType === definition.ownerType &&
      this.ownerDefinition.ownerRef === definition.ownerRef;
  }

  get type(): string {
    return this.tags.type;
  }

  get isDeleted(): boolean {
    return this.lifecycle === "deleted";
  }

  get isRenamed(): boolean {
    return this.lifecycle === "deleted" && this.renamedTo !== undefined;
  }

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
