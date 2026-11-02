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

import {
  isIssuedEntry,
  jsonEscaped,
  type RegistryEntry,
  SecretBagRegistry,
  type SecretReference,
  SENTINEL_MARK,
  SENTINEL_SOURCE,
} from "../vaults/secret_bag_registry.ts";
import type { SecretRedactor } from "./secret_redactor.ts";

const SENTINEL_PATTERN = new RegExp(SENTINEL_SOURCE, "g");

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

export type SecretSource = SecretReference;

export interface SecretSink {
  addSecret(value: string, source?: SecretSource): void;
  /**
   * records a stored reference whose vault read failed; the text stays in the
   * record, this keeps why so the run can name the failed read
   */
  recordUnread?(reference: UnreadSensitiveReference): void;
}

export interface UnreadSensitiveReference extends SecretSource {
  readonly text: string;
  readonly fieldPath: string;
  readonly reason: string;
}

export interface UnreadReferenceLookup {
  unreadReferenceFor(text: string): UnreadSensitiveReference | undefined;
}

export function describeUnreadReference(
  reference: UnreadSensitiveReference,
): string {
  return `vault '${reference.vaultName}', key '${reference.key}': ${reference.reason}`;
}

export interface SensitiveEntry {
  readonly value: string;
  readonly source: SecretSource;
}

/** Values shorter than this are never recorded, matching SecretRedactor. */
const MIN_SECRET_LENGTH = 3;

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
 * every value is forwarded to the redactor so logs and the persisted shell
 * command field mask it; every bag of the run views one sentinel registry,
 * child runs included
 */
export class RunSensitiveValues implements SecretSink, UnreadReferenceLookup {
  private readonly entries = new Map<string, SecretSource>();
  private readonly unread = new Map<string, UnreadSensitiveReference>();
  private sorted: SensitiveEntry[] | undefined;

  constructor(
    private readonly redactor?: SecretRedactor,
    readonly sentinels: SecretBagRegistry = new SecretBagRegistry(),
  ) {
    // In a typed run the redactor masks the run's sentinels too, so logs,
    // streamed output and errors share one implementation with the masks
    // below (design/enablers/typed-secrets.md Section 7.1).
    redactor?.maskSentinelsOf(sentinels);
  }

  /**
   * an existence probe's value goes to this redactor and is dropped; undefined
   * when the run has none
   */
  get probeRedactor(): SecretRedactor | undefined {
    return this.redactor;
  }

  private get derivesFromSentinels(): boolean {
    return (!this.sentinels.isEmpty);
  }

  private withSentinelStandIns(
    text: string,
    standIn: (entry: RegistryEntry) => string,
  ): string {
    if (!this.derivesFromSentinels || !text.includes(SENTINEL_MARK)) {
      return text;
    }
    return text.replace(SENTINEL_PATTERN, (sentinel) => {
      const entry = this.sentinels.entryOf(sentinel);
      return entry === undefined ? sentinel : standIn(entry);
    });
  }

  addSecret(value: string, source?: SecretSource): void {
    this.redactor?.addSecret(value);
    if (!source) return;
    if (value.length < MIN_SECRET_LENGTH) return;
    if (!this.entries.has(value)) {
      this.entries.set(value, source);
      this.sorted = undefined;
    }
  }

  recordUnread(reference: UnreadSensitiveReference): void {
    this.unread.set(reference.text, reference);
  }

  /**
   * the reason is masked through the run's redactor since a provider's error
   * can echo input
   */
  unreadReferenceFor(text: string): UnreadSensitiveReference | undefined {
    const reference = this.unread.get(text);
    if (!reference || !this.redactor?.hasSecrets) return reference;
    return { ...reference, reason: this.redactor.redact(reference.reason) };
  }

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

  sourceOf(value: string): SecretSource | undefined {
    return this.entries.get(value);
  }

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

  /** an entry with no reference (one a worker rebuilt) becomes the mask */
  withPlaceholders(text: string): string {
    // Sentinels first: a recorded value that is a fragment of a sentinel
    // must not break the sentinel apart before it is recognised.
    let result = this.withSentinelStandIns(
      text,
      (entry) =>
        isIssuedEntry(entry) ? this.placeholderFor(entry.reference) : "***",
    );
    for (const { value, source } of this.list()) {
      if (result.includes(value)) {
        result = result.split(value).join(this.placeholderFor(source));
      }
    }
    return result;
  }

  /**
   * apply before deriving a name from the value, since that rewrites the text
   * and would hide the value from matching
   */
  withPlaceholdersDeep(value: unknown): unknown {
    if (this.isEmpty && !this.derivesFromSentinels) return value;
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

  /**
   * the stand-in is the item's position, derived without reading a value and
   * stable across resume whatever the secret was
   */
  withForEachStandIns(text: string, index: number): string {
    return this.withSentinelStandIns(text, () => `sensitive-${index}`);
  }

  tagsWithPlaceholders(
    tags: Record<string, string>,
  ): Record<string, string> {
    if (this.isEmpty && !this.derivesFromSentinels) return tags;
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
   * a number or boolean equal to a recorded value becomes the string ***, so
   * the result is not the input's type
   */
  masked(value: unknown): unknown {
    if (this.isEmpty && !this.derivesFromSentinels) return value;
    return this.maskDeep(value);
  }

  private maskDeep(value: unknown): unknown {
    if (typeof value === "string") {
      let result = this.withSentinelStandIns(value, () => "***");
      for (const { value: secret } of this.list()) {
        if (result.includes(secret)) result = result.split(secret).join("***");
        const escaped = jsonEscaped(secret);
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
