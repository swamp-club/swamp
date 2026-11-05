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
 * Extension-author-facing subset of swamp's vault types.
 *
 * These types mirror the fields that extension vault implementations
 * actually use. A CI test in the main swamp repo verifies structural
 * compatibility with the canonical types.
 */

/**
 * Options for the VaultProvider.put() method.
 */
export interface VaultPutOptions {
  /** Provider-native tags to attach to the secret at creation time. */
  tags?: Record<string, string>;
}

/** The `code` a vault provider's error carries when a secret does not exist. */
export const SECRET_NOT_FOUND_CODE = "secret_not_found";

const MAX_CAUSE_DEPTH = 8;

/**
 * Thrown by a vault provider's `get()` when the key does not exist, and only
 * then — never for an authentication, permission or network failure.
 *
 * swamp keeps the `code` intact through `context.readResource()` and vault
 * expressions, on local and remote workers. Check for it with {@link isSecretNotFoundError}, not `instanceof`:
 * each extension bundle carries its own copy of this class.
 *
 * @example
 * ```ts
 * import { SecretNotFoundError } from "@swamp-club/swamp-testing";
 *
 * async get(key: string): Promise<string> {
 *   const value = await lookup(key);
 *   if (value === undefined) throw new SecretNotFoundError(this.name, key);
 *   return value;
 * }
 * ```
 */
export class SecretNotFoundError extends Error {
  /** Always {@link SECRET_NOT_FOUND_CODE}. */
  readonly code: typeof SECRET_NOT_FOUND_CODE = SECRET_NOT_FOUND_CODE;

  constructor(
    /** The vault the key was looked up in. */
    readonly vaultName: string,
    /** The key that does not exist. */
    readonly key: string,
    options?: { message?: string; cause?: unknown },
  ) {
    super(
      options?.message ?? `Secret '${key}' not found in vault '${vaultName}'`,
    );
    this.name = "SecretNotFoundError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * True when the error, or an error in its `cause` chain, carries the
 * {@link SECRET_NOT_FOUND_CODE}. Matches by `code`, so it recognises the error
 * whichever bundle or process constructed it.
 *
 * @example
 * ```ts
 * try {
 *   session = await context.readResource("session");
 * } catch (err) {
 *   if (!isSecretNotFoundError(err)) throw err;
 *   session = await logIn();
 * }
 * ```
 */
export function isSecretNotFoundError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if ((current as { code?: unknown }).code === SECRET_NOT_FOUND_CODE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Interface for vault providers that securely store and retrieve secrets.
 *
 * Extension authors implement this interface to create custom vault backends.
 */
export interface VaultProvider {
  /**
   * Retrieves a secret value from the vault. Rejects with a
   * {@link SecretNotFoundError} (or any error whose `code` is
   * `"secret_not_found"`) when the key does not exist, and with any other
   * error for every other failure.
   */
  get(secretKey: string): Promise<string>;
  /** Stores a secret value in the vault. */
  put(
    secretKey: string,
    secretValue: string,
    options?: VaultPutOptions,
  ): Promise<void>;
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

/**
 * Optional interface for vault providers that can answer whether a secret
 * exists without reading its value. Separate from VaultProvider — providers
 * opt in by implementing both.
 *
 * `has(secretKey)` resolves `true` exactly when `get(secretKey)` would succeed
 * under the same provider credentials, `false` for a key that does not exist,
 * and rejects with the same error `get` raises when the caller is not
 * authorized. It never reads the value, and presence in a listing or a
 * describe call is not enough. Implement it only where the backing API can
 * answer without reading the value; swamp otherwise falls back to one probe
 * read per reference per run.
 */
export interface VaultExistenceProvider {
  has(secretKey: string): Promise<boolean>;
}
