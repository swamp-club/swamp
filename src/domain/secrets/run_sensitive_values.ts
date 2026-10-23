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

/**
 * The vault location a resolved secret was read from: the same vault name
 * and key a bag entry references.
 */
export type SecretSource = SecretReference;

/**
 * Receives secret values as they are resolved from vault references.
 * `SecretRedactor` and {@link RunSensitiveValues} both satisfy it.
 */
export interface SecretSink {
  addSecret(value: string, source?: SecretSource): void;
  /**
   * Records a stored sensitive-field reference whose vault read failed. The
   * reference text stays in the record; this keeps why, so the run can name
   * the failed read where the text is refused or used (swamp-club#3806).
   */
  recordUnread?(reference: UnreadSensitiveReference): void;
}

/**
 * A stored sensitive-field reference the run tried to read from its vault and
 * could not: where it points, the field it sits at, and the provider's error.
 */
export interface UnreadSensitiveReference extends SecretSource {
  /** The reference text exactly as the record stores it. */
  readonly text: string;
  readonly fieldPath: string;
  readonly reason: string;
}

/**
 * Finds the failed read recorded for a stored reference's exact text;
 * {@link RunSensitiveValues} keeps the run's record.
 */
export interface UnreadReferenceLookup {
  unreadReferenceFor(text: string): UnreadSensitiveReference | undefined;
}

/**
 * Describes a failed sensitive-field read for a warning or an error: the
 * vault, the key, and the provider's reason.
 */
export function describeUnreadReference(
  reference: UnreadSensitiveReference,
): string {
  return `vault '${reference.vaultName}', key '${reference.key}': ${reference.reason}`;
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
 * persisted shell command field mask it. It carries the run's sentinel
 * registry, the index of the same secrets by sentinel, so every bag of the
 * run is a view of one registry wherever the run's values go, child runs
 * included.
 */
export class RunSensitiveValues implements SecretSink, UnreadReferenceLookup {
  private readonly entries = new Map<string, SecretSource>();
  /** Failed sensitive-field reads, by their stored reference text. */
  private readonly unread = new Map<string, UnreadSensitiveReference>();
  /** list() result, rebuilt only after a new value is recorded. */
  private sorted: SensitiveEntry[] | undefined;

  constructor(
    private readonly redactor?: SecretRedactor,
    /** The sentinels this run issued; every bag of the run issues into it. */
    readonly sentinels: SecretBagRegistry = new SecretBagRegistry(),
  ) {
    // In a typed run the redactor masks the run's sentinels too, so logs,
    // streamed output and errors share one implementation with the masks
    // below (design/enablers/typed-secrets.md Section 7.1).
    redactor?.maskSentinelsOf(sentinels);
  }

  /**
   * The run's redactor, for the vault check scope of a typed evaluation: an
   * existence probe's value goes to it and is dropped
   * (design/enablers/typed-secrets.md Section 3.4). Undefined when the run
   * has none.
   */
  get probeRedactor(): SecretRedactor | undefined {
    return this.redactor;
  }

  /**
   * Whether masks and stand-ins are also derived from the sentinels the run
   * issued: a typed run that issued at least one. Reading a registry entry
   * loads nothing.
   */
  private get derivesFromSentinels(): boolean {
    return (!this.sentinels.isEmpty);
  }

  /**
   * Replaces every sentinel the run issued in `text` with what `standIn`
   * makes of its entry, in a typed run. Sentinel-shaped text with another
   * prefix, or that the run did not issue, stays as it is.
   */
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
   * The failed read recorded for `text`, when it is exactly the stored
   * reference of a sensitive field this run could not read. The reason is
   * masked through the run's redactor, since a provider's error can echo
   * input.
   */
  unreadReferenceFor(text: string): UnreadSensitiveReference | undefined {
    const reference = this.unread.get(text);
    if (!reference || !this.redactor?.hasSecrets) return reference;
    return { ...reference, reason: this.redactor.redact(reference.reason) };
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

  /**
   * Replaces every recorded value in the text with its placeholder, and in a
   * typed run every sentinel the run issued with the placeholder of its
   * reference, derived from the sentinel without reading a value. An entry
   * with no reference (one a worker rebuilt) becomes the mask.
   */
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
   * Replaces recorded values with placeholders throughout a structure: in every
   * string, and as a whole number or boolean whose text is a recorded value.
   * Apply before deriving a name from the value (a data-name suffix), since
   * that derivation rewrites the text and would hide the value from matching.
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
   * Replaces every sentinel the run issued in a forEach step name with the
   * iteration's stand-in, `sensitive-<index>`, derived from the sentinel
   * without reading a value (typed-secrets 4.1): the item's position is the
   * identity, stable across resume, whatever the secret was.
   */
  withForEachStandIns(text: string, index: number): string {
    return this.withSentinelStandIns(text, () => `sensitive-${index}`);
  }

  /** Replaces recorded values in every tag or label value with placeholders. */
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
   * Masks every recorded value in a structure with `***` for display, and
   * in a typed run every sentinel the run issued, whatever it stands for and
   * without reading it. A number or boolean equal to a recorded value
   * becomes the string `***`, so the result is not the input's type.
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
