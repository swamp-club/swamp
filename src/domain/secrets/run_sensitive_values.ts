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

import type { SecretRedactor } from "./secret_redactor.ts";

/**
 * Sets an own, enumerable property, so a key named `__proto__` in copied data
 * is kept as data rather than replacing the copy's prototype.
 */
export function definedEntry(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** The vault location a resolved secret was read from. */
export interface SecretSource {
  readonly vaultName: string;
  readonly key: string;
}

/**
 * Receives secret values as they are resolved from vault references.
 * `SecretRedactor` and {@link RunSensitiveValues} both satisfy it.
 */
export interface SecretSink {
  addSecret(value: string, source?: SecretSource): void;
}

/** A recorded sensitive value and where it came from. */
export interface SensitiveEntry {
  readonly value: string;
  readonly source: SecretSource;
}

/** Values shorter than this are never recorded, matching SecretRedactor. */
const MIN_SECRET_LENGTH = 3;

/**
 * Builds the vault reference text a data record stores for a sensitive field,
 * the same form `processSensitiveResourceData` writes.
 */
export function vaultReferenceText(source: SecretSource): string {
  return `\${{ vault.get('${source.vaultName}', '${source.key}') }}`;
}

/**
 * Encodes a vault key for use inside a name. Percent-encoding is reversible,
 * and encoding the dot means a sanitized suffix can never merge two keys.
 */
function encodeKeyForName(key: string): string {
  return encodeURIComponent(key).replaceAll(".", "%2E");
}

/**
 * The sensitive values one run resolved for schema-marked sensitive fields,
 * each with the vault and key it was resolved from.
 *
 * Created once per run alongside the run's SecretRedactor and passed
 * explicitly to every place that resolves sensitive vault references for
 * expressions. Every value is forwarded to the redactor, so logs and the
 * persisted shell command field mask it.
 */
export class RunSensitiveValues implements SecretSink {
  private readonly entries = new Map<string, SecretSource>();
  /** list() result, rebuilt only after a new value is recorded. */
  private sorted: SensitiveEntry[] | undefined;

  constructor(private readonly redactor?: SecretRedactor) {}

  addSecret(value: string, source?: SecretSource): void {
    this.redactor?.addSecret(value);
    if (!source) return;
    if (value.length < MIN_SECRET_LENGTH) return;
    if (!this.entries.has(value)) {
      this.entries.set(value, source);
      this.sorted = undefined;
    }
  }

  /** Whether no value has been recorded. */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** Recorded values, longest first so overlapping values never split. */
  list(): readonly SensitiveEntry[] {
    this.sorted ??= [...this.entries]
      .map(([value, source]) => ({ value, source }))
      .sort((a, b) => b.value.length - a.value.length);
    return this.sorted;
  }

  /** The vault source a value was resolved from, if it was recorded. */
  sourceOf(value: string): SecretSource | undefined {
    return this.entries.get(value);
  }

  /** Whether the text contains any recorded value. */
  occursIn(text: string): boolean {
    for (const value of this.entries.keys()) {
      if (text.includes(value)) return true;
    }
    return false;
  }

  /**
   * Stable, non-secret stand-in for a recorded value inside a name, tag,
   * label or suffix: `sensitive-<vault>.<key>`. Vault names cannot contain a
   * dot, and the key is percent-encoded, so distinct secrets never share one.
   */
  placeholderFor(source: SecretSource): string {
    return `sensitive-${source.vaultName}.${encodeKeyForName(source.key)}`;
  }

  /** Replaces every recorded value in the text with its placeholder. */
  withPlaceholders(text: string): string {
    let result = text;
    for (const { value, source } of this.list()) {
      if (result.includes(value)) {
        result = result.split(value).join(this.placeholderFor(source));
      }
    }
    return result;
  }

  /**
   * Replaces recorded values with placeholders throughout a structure: in every
   * string, and as a whole number or boolean whose text is a recorded value.
   * Apply before deriving a name from the value (a data-name suffix), since
   * that derivation rewrites the text and would hide the value from matching.
   */
  withPlaceholdersDeep(value: unknown): unknown {
    if (this.isEmpty) return value;
    if (typeof value === "string") return this.withPlaceholders(value);
    if (typeof value === "number" || typeof value === "boolean") {
      const source = this.entries.get(String(value));
      return source ? this.placeholderFor(source) : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.withPlaceholdersDeep(item));
    }
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        definedEntry(result, key, this.withPlaceholdersDeep(item));
      }
      return result;
    }
    return value;
  }

  /** Replaces recorded values in every tag or label value with placeholders. */
  tagsWithPlaceholders(
    tags: Record<string, string>,
  ): Record<string, string> {
    if (this.isEmpty) return tags;
    const result: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(tags)) {
      definedEntry(
        result,
        key,
        typeof value === "string" ? this.withPlaceholders(value) : value,
      );
    }
    return result;
  }

  /**
   * Masks every recorded value in a structure with `***` for display. A
   * number or boolean equal to a recorded value becomes the string `***`, so
   * the result is not the input's type.
   */
  masked(value: unknown): unknown {
    if (this.isEmpty) return value;
    return this.maskDeep(value);
  }

  private maskDeep(value: unknown): unknown {
    if (typeof value === "string") {
      let result = value;
      for (const { value: secret } of this.list()) {
        if (result.includes(secret)) result = result.split(secret).join("***");
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (escaped !== secret && result.includes(escaped)) {
          result = result.split(escaped).join("***");
        }
      }
      return result;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return this.entries.has(String(value)) ? "***" : value;
    }
    if (Array.isArray(value)) return value.map((item) => this.maskDeep(item));
    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        definedEntry(result, key, this.maskDeep(item));
      }
      return result;
    }
    return value;
  }
}
