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

import { UserError } from "../errors.ts";

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

/** The prefix every sentinel starts with, for a quick check before a full scan. */
export const SENTINEL_MARK = "__SWAMP_VSEC_";

/** Matches exactly one sentinel. */
export const SENTINEL_EXACT = new RegExp(`^${SENTINEL_SOURCE}$`);

const SENTINEL_PARTS = /^__SWAMP_VSEC_([0-9a-f]{32})_\d+__$/;

/**
 * How a sentinel's value was written where the sentinel stands: as `raw`
 * text, as its JSON-escaped form (`json`) inside JSON text, or as the whole
 * `number` or `boolean` leaf a coercion produced. A pass issues `raw` entries,
 * and the legacy data path `raw` or `json` ones; the other encodings are read
 * back from the written references of an existing file
 * (design/enablers/typed-secrets.md Section 8.1), and delivery applies them
 * ({@link jsonEscaped}, {@link restoreScalar}).
 */
export const SECRET_ENCODINGS = ["raw", "json", "number", "boolean"] as const;
export type SecretEncoding = (typeof SECRET_ENCODINGS)[number];

/** A value's JSON-escaped form: how it sits inside JSON text. */
export function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * The number or boolean a `number` or `boolean` entry delivers for a loaded
 * value. Throws when the vault now holds something else (a rotated value),
 * naming the reference and the position it is delivered at, never the value,
 * rather than delivering NaN or false in its place.
 */
export function restoreScalar(
  encoding: "number" | "boolean",
  value: string,
  reference: SecretReference,
  /** The record and position the entry is delivered at, never a file path. */
  position: string,
): number | boolean {
  if (encoding === "boolean") {
    if (value === "true" || value === "false") return value === "true";
  } else if (value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new UserError(
    `The value in vault '${reference.vaultName}' key '${reference.key}' is no longer a ${encoding}, so it cannot be delivered where one was written (at ${position}). ` +
      `Restore the vault value, or evaluate again so the value is read afresh.`,
  );
}

/** One sentinel of a VaultSecretBag, in the shape a dispatch ships it. */
export interface SecretBagEntry {
  sentinel: string;
  value: string;
  /** True when the secret reached the step through a data read. */
  dataOrigin: boolean;
}

/**
 * A vault.get() reference a pass issued, or a vault-origin written reference
 * a rehydration restored from an existing file. It holds no value: a load
 * reads one at delivery, for that delivery attempt only, and delivery applies
 * the encoding the file recorded.
 */
export interface VaultReferenceEntry {
  sentinel: string;
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: false;
  /**
   * Where the author wrote the reference, or the record and position a
   * rehydration restored it from, for a load's errors.
   */
  location: string;
}

/**
 * A secret that reached a step through a data read on the legacy path. It
 * keeps the value the read brought into the expression, until typed-secrets
 * Phase 4 makes every data read return references.
 */
export interface DataSecretEntry extends SecretBagEntry {
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: true;
}

/**
 * A sensitive-field reference a typed data read brought into an expression
 * (typed-secrets 3.3), or a data-origin written reference a rehydration
 * restored from an existing file. It holds no value: a load reads one at
 * delivery, as for a vault.get() reference, and the location names the
 * record and the field the reference was read from.
 */
export interface DataReferenceEntry {
  sentinel: string;
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: true;
  /** The record and field the reference was read from, for a load's errors. */
  location: string;
}

/** An issued entry that holds no value, so a delivery loads one. */
export type ReferenceOnlyEntry = VaultReferenceEntry | DataReferenceEntry;

/**
 * An entry a pass of a run issued. It answers its reference, its encoding
 * and its origin without reading a value. Every entry an orchestrator
 * issues is one; only a worker rebuilding a dispatched bag stores the plain
 * shape, because the dispatch carries no reference until typed-secrets
 * Phase 5.
 */
export type IssuedSecretBagEntry =
  | VaultReferenceEntry
  | DataSecretEntry
  | DataReferenceEntry;

/** Any entry a registry holds. */
export type RegistryEntry = IssuedSecretBagEntry | SecretBagEntry;

/** Whether an entry carries its reference. */
export function isIssuedEntry(
  entry: RegistryEntry,
): entry is IssuedSecretBagEntry {
  return "reference" in entry;
}

/** Whether an entry holds its value, which a reference-only entry never does. */
export function holdsValue(
  entry: RegistryEntry,
): entry is SecretBagEntry | DataSecretEntry {
  return "value" in entry;
}

/** How a run's registry is built. Internal: only tests set anything here. */
export interface SecretBagRegistryOptions {
  /**
   * Whether the run's secrets are typed: its expressions evaluate with the
   * internal option (`CelEvaluatorOptions.typedSecrets`), and its
   * destinations apply the policies of design/enablers/typed-secrets.md
   * Section 7, read from this flag by the method boundary, the shell
   * behavior, `RunSensitiveValues` and `SecretRedactor`. Set only by tests
   * until Phase 4 turns the path on for every entry point (Section 10.3); a
   * fitness test keeps production code from passing it.
   */
  readonly typedSecrets?: boolean;
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
  /** Whether the run's secrets are typed ({@link SecretBagRegistryOptions}). */
  readonly typedSecrets: boolean;
  private readonly entries = new Map<string, RegistryEntry>();
  /** Each sentinel's position in issue order. */
  private readonly sequence = new Map<string, number>();
  private readonly prefixes = new Set<string>();
  /** Each reference's existence answer: in flight, or confirmed. */
  private readonly existence = new Map<string, Promise<void>>();

  constructor(options: SecretBagRegistryOptions = {}) {
    this.typedSecrets = options.typedSecrets === true;
  }

  /**
   * A new, empty registry carrying this one's option and nothing else: no
   * entry, no prefix and no existence answer. A nested invocation issues into
   * one, so it checks every reference anew while keeping the run's
   * typed-secrets option (design/enablers/typed-secrets.md Sections 3.2 and
   * 3.4). Production code reaches a typed registry only by forwarding an
   * existing one's option this way, never by setting it.
   */
  independent(): SecretBagRegistry {
    return new SecretBagRegistry({ typedSecrets: this.typedSecrets });
  }

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
