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
 * An entry a pass of a run issued. It answers its reference, its encoding
 * and its origin without reading its value. Every entry an orchestrator
 * issues is one; only a worker rebuilding a dispatched bag stores the plain
 * shape, because the dispatch carries no reference until typed-secrets
 * Phase 5.
 */
export interface IssuedSecretBagEntry extends SecretBagEntry {
  reference: SecretReference;
  encoding: SecretEncoding;
}

/** Whether an entry carries its reference. */
export function isIssuedEntry(
  entry: SecretBagEntry,
): entry is IssuedSecretBagEntry {
  return "reference" in entry;
}

/**
 * The sentinels one run issued, keyed by sentinel, with the prefixes its
 * bags drew. Every pass of a run issues into one registry, and each
 * VaultSecretBag is a view of it: a bag issues under its own prefix and
 * resolves any sentinel the registry holds, so a sentinel issued in an
 * earlier pass is never delivered as literal text. A child run shares its
 * parent's registry, as it shares its parent's RunSensitiveValues.
 */
export class SecretBagRegistry {
  private readonly entries = new Map<string, SecretBagEntry>();
  /** Each sentinel's position in issue order. */
  private readonly sequence = new Map<string, number>();
  private readonly prefixes = new Set<string>();

  /** Records a prefix a bag of this registry drew. */
  drawPrefix(prefix: string): void {
    this.prefixes.add(prefix);
  }

  /** Adds an entry. A sentinel is registered once; a repeat throws. */
  register(entry: SecretBagEntry | IssuedSecretBagEntry): void {
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
  entryOf(sentinel: string): SecretBagEntry | undefined {
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
  all(): IterableIterator<SecretBagEntry> {
    return this.entries.values();
  }
}
