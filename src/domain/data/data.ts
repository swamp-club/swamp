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

import { createDataId, type DataId, generateDataId } from "./data_id.ts";
import {
  type DataMetadata,
  DataMetadataSchema,
  type GarbageCollectionPolicy,
  type Lifetime,
  normalizeLifetime,
  type OwnerDefinition,
} from "./data_metadata.ts";

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
    readonly size?: number,
    readonly checksum?: string,
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
      validated.size,
      validated.checksum,
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
      validated.size,
      validated.checksum,
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
    });
  }
}
