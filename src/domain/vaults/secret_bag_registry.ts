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

/** The vault name and key a secret stands for. */
export interface SecretReference {
  readonly vaultName: string;
  readonly key: string;
}

/**
 * A sentinel is `__SWAMP_VSEC_<prefix>_<n>__`: a 128-bit random prefix the
 * issuing bag drew, as 32 hex characters, and the bag's issue counter.
 */
export const SENTINEL_SOURCE = "__SWAMP_VSEC_[0-9a-f]{32}_\\d+__";

/** Matches exactly one sentinel. */
export const SENTINEL_EXACT = new RegExp(`^${SENTINEL_SOURCE}$`);

const SENTINEL_PARTS = /^__SWAMP_VSEC_([0-9a-f]{32})_\d+__$/;

/**
 * How a sentinel's value was written where the sentinel stands: as `raw`
 * text, or as its JSON-escaped form (`json`) inside JSON text.
 */
export type SecretEncoding = "raw" | "json";

/** One sentinel of a VaultSecretBag, in the shape a dispatch ships it. */
export interface SecretBagEntry {
  sentinel: string;
  value: string;
  /** True when the secret reached the step through a data read. */
  dataOrigin: boolean;
}

/**
 * A vault.get() reference a pass issued. It holds no value: a load reads
 * one at delivery, for that delivery attempt only.
 */
export interface VaultReferenceEntry {
  sentinel: string;
  reference: SecretReference;
  encoding: "raw";
  dataOrigin: false;
  /** Where the author wrote the reference, for a load's errors. */
  location: string;
}

/**
 * A secret that reached a step through a data read. It keeps the value the
 * read brought into the expression, until typed-secrets Phase 4 makes data
 * reads return references too.
 */
export interface DataSecretEntry extends SecretBagEntry {
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: true;
}

/**
 * An entry a pass of a run issued. It answers its reference, its encoding
 * and its origin without reading a value. Every entry an orchestrator
 * issues is one; only a worker rebuilding a dispatched bag stores the plain
 * shape, because the dispatch carries no reference until typed-secrets
 * Phase 5.
 */
export type IssuedSecretBagEntry = VaultReferenceEntry | DataSecretEntry;

/** Any entry a registry holds. */
export type RegistryEntry = IssuedSecretBagEntry | SecretBagEntry;

/** Whether an entry carries its reference. */
export function isIssuedEntry(
  entry: RegistryEntry,
): entry is IssuedSecretBagEntry {
  return "reference" in entry;
}

/** Whether an entry holds its value, which a vault reference never does. */
export function holdsValue(
  entry: RegistryEntry,
): entry is SecretBagEntry | DataSecretEntry {
  return "value" in entry;
}

/**
 * The sentinels one run issued, keyed by sentinel, with the prefixes its
 * bags drew. Every pass of a run issues into one registry, and each
 * VaultSecretBag is a view of it: a bag issues under its own prefix and
 * resolves any sentinel the registry holds, so a sentinel issued in an
 * earlier pass is never delivered as literal text. A child run shares its
 * parent's registry, as it shares its parent's RunSensitiveValues. No
 * vault.get() entry holds a value; each delivery loads its own.
 */
export class SecretBagRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  /** Each sentinel's position in issue order. */
  private readonly sequence = new Map<string, number>();
  private readonly prefixes = new Set<string>();
  /** Each reference's existence answer: in flight, or confirmed. */
  private readonly existence = new Map<string, Promise<void>>();

  /** Records a prefix a bag of this registry drew. */
  drawPrefix(prefix: string): void {
    this.prefixes.add(prefix);
  }

  /**
   * Answers whether `reference` exists once for this registry, so once for
   * the run tree that shares it: `ask` runs for the first caller, and every
   * caller while it is in flight shares its answer. A confirmation is kept;
   * a rejection is dropped, so the next caller asks again. Authorization is
   * the caller's to check on every call.
   */
  confirmExists(
    reference: SecretReference,
    ask: () => Promise<void>,
  ): Promise<void> {
    const id = `${reference.vaultName}\u0000${reference.key}`;
    let answer = this.existence.get(id);
    if (answer === undefined) {
      const asked = Promise.resolve().then(ask).catch((error: unknown) => {
        if (this.existence.get(id) === asked) this.existence.delete(id);
        throw error;
      });
      answer = asked;
      this.existence.set(id, answer);
    }
    return answer;
  }

  /** Adds an entry. A sentinel is registered once; a repeat throws. */
  register(entry: RegistryEntry): void {
    const parts = SENTINEL_PARTS.exec(entry.sentinel);
    if (!parts) {
      throw new Error("Malformed vault secret sentinel in secret bag entry");
    }
    if (this.entries.has(entry.sentinel)) {
      throw new Error("A vault secret sentinel was issued twice in one run");
    }
    this.prefixes.add(parts[1]);
    this.sequence.set(entry.sentinel, this.entries.size);
    this.entries.set(entry.sentinel, entry);
  }

  /** The entry behind a sentinel this registry holds. */
  entryOf(sentinel: string): RegistryEntry | undefined {
    return this.entries.get(sentinel);
  }

  /**
   * Where a sentinel sits in issue order, so a few looked-up entries can be
   * ordered as a scan of every entry would order them.
   */
  sequenceOf(sentinel: string): number | undefined {
    return this.sequence.get(sentinel);
  }

  /** The entry behind a sentinel a pass of this run issued. */
  issuedEntryOf(sentinel: string): IssuedSecretBagEntry | undefined {
    const entry = this.entries.get(sentinel);
    return entry && isIssuedEntry(entry) ? entry : undefined;
  }

  /**
   * Whether sentinel-shaped text carries a prefix a bag of this registry
   * drew. True with no entry means a sentinel this run issued but never
   * registered, which cannot happen through a bag; false means the text is
   * data from elsewhere.
   */
  drewPrefixOf(sentinel: string): boolean {
    const parts = SENTINEL_PARTS.exec(sentinel);
    return parts !== null && this.prefixes.has(parts[1]);
  }

  /** Whether no sentinel has been issued. */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** Every entry, in issue order. */
  all(): IterableIterator<RegistryEntry> {
    return this.entries.values();
  }
}
