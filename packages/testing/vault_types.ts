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

/**
 * Extension-author-facing subset of swamp's vault types.
 *
 * These types mirror the fields that extension vault implementations
 * actually use. A CI test in the main swamp repo verifies structural
 * compatibility with the canonical types.
 */

/**
 * Interface for vault providers that securely store and retrieve secrets.
 *
 * Extension authors implement this interface to create custom vault backends.
 */
export interface VaultProvider {
  /** Retrieves a secret value from the vault. */
  get(secretKey: string): Promise<string>;
  /** Stores a secret value in the vault. */
  put(secretKey: string, secretValue: string): Promise<void>;
  /** Lists all secret keys in the vault (names only, not values). */
  list(): Promise<string[]>;
  /** Gets the name/type of this vault provider. */
  getName(): string;
}

/** Serializable representation of a vault annotation. */
export interface VaultAnnotationData {
  url?: string;
  notes?: string;
  labels?: Record<string, string>;
  updatedAt: string;
}

/** Value object representing metadata attached to a vault secret. */
export class VaultAnnotation {
  readonly url: string | undefined;
  readonly notes: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
  readonly updatedAt: Date;

  private constructor(
    url: string | undefined,
    notes: string | undefined,
    labels: Record<string, string>,
    updatedAt: Date,
  ) {
    this.url = url;
    this.notes = notes;
    this.labels = Object.freeze({ ...labels });
    this.updatedAt = updatedAt;
  }

  static create(fields: {
    url?: string;
    notes?: string;
    labels?: Record<string, string>;
  }): VaultAnnotation {
    return new VaultAnnotation(
      fields.url,
      fields.notes,
      fields.labels ?? {},
      new Date(),
    );
  }

  static fromData(data: VaultAnnotationData): VaultAnnotation {
    return new VaultAnnotation(
      data.url,
      data.notes,
      data.labels ?? {},
      new Date(data.updatedAt),
    );
  }

  toData(): VaultAnnotationData {
    const data: VaultAnnotationData = {
      updatedAt: this.updatedAt.toISOString(),
    };
    if (this.url !== undefined) data.url = this.url;
    if (this.notes !== undefined) data.notes = this.notes;
    if (Object.keys(this.labels).length > 0) {
      data.labels = { ...this.labels };
    }
    return data;
  }

  merge(updates: {
    url?: string;
    notes?: string;
    labels?: Record<string, string>;
  }): VaultAnnotation {
    return new VaultAnnotation(
      updates.url !== undefined ? updates.url : this.url,
      updates.notes !== undefined ? updates.notes : this.notes,
      updates.labels !== undefined
        ? { ...this.labels, ...updates.labels }
        : { ...this.labels },
      new Date(),
    );
  }

  isEmpty(): boolean {
    return this.url === undefined &&
      this.notes === undefined &&
      Object.keys(this.labels).length === 0;
  }

  equals(other: VaultAnnotation): boolean {
    if (this.url !== other.url) return false;
    if (this.notes !== other.notes) return false;
    const thisKeys = Object.keys(this.labels).sort();
    const otherKeys = Object.keys(other.labels).sort();
    if (thisKeys.length !== otherKeys.length) return false;
    for (let i = 0; i < thisKeys.length; i++) {
      if (thisKeys[i] !== otherKeys[i]) return false;
      if (this.labels[thisKeys[i]] !== other.labels[otherKeys[i]]) return false;
    }
    return true;
  }
}

/**
 * Interface for vault providers that support secret annotations.
 * Separate from VaultProvider — providers opt in by implementing both.
 */
export interface VaultAnnotationProvider {
  getAnnotation(secretKey: string): Promise<VaultAnnotation | null>;
  putAnnotation(
    secretKey: string,
    annotation: VaultAnnotation,
  ): Promise<void>;
  deleteAnnotation(secretKey: string): Promise<void>;
  listAnnotations(): Promise<Map<string, VaultAnnotation>>;
}
