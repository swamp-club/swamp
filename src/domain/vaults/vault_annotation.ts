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

/**
 * Serializable representation of a vault annotation.
 */
export interface VaultAnnotationData {
  url?: string;
  notes?: string;
  labels?: Record<string, string>;
  updatedAt: string;
}

/**
 * Value object representing metadata attached to a vault secret.
 */
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

  removeLabels(keys: string[]): VaultAnnotation {
    const newLabels = { ...this.labels };
    for (const key of keys) {
      delete newLabels[key];
    }
    return new VaultAnnotation(
      this.url,
      this.notes,
      newLabels,
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

/**
 * Type guard to check if a vault provider supports annotations.
 */
export function isVaultAnnotationProvider(
  provider: unknown,
): provider is VaultAnnotationProvider {
  if (typeof provider !== "object" || provider === null) return false;
  const obj = provider as Record<string, unknown>;
  return typeof obj.getAnnotation === "function" &&
    typeof obj.putAnnotation === "function" &&
    typeof obj.deleteAnnotation === "function" &&
    typeof obj.listAnnotations === "function";
}
