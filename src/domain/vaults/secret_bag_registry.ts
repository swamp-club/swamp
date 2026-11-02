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

export interface SecretReference {
  readonly vaultName: string;
  readonly key: string;
}

export const SENTINEL_SOURCE = "__SWAMP_VSEC_[0-9a-f]{32}_\\d+__";

export const SENTINEL_MARK = "__SWAMP_VSEC_";

export const SENTINEL_EXACT = new RegExp(`^${SENTINEL_SOURCE}$`);

const SENTINEL_PARTS = /^__SWAMP_VSEC_([0-9a-f]{32})_\d+__$/;

export const SECRET_ENCODINGS = ["raw", "json", "number", "boolean"] as const;
export type SecretEncoding = (typeof SECRET_ENCODINGS)[number];

export function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * throws naming the reference and position, never the value, when a rotated
 * value is not a number or boolean, rather than delivering NaN or false
 */
export function restoreScalar(
  encoding: "number" | "boolean",
  value: string,
  reference: SecretReference,
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

export interface SecretBagEntry {
  sentinel: string;
  value: string;
  dataOrigin: boolean;
  jsonValue?: true;
}

export interface ShippedReferenceEntry {
  sentinel: string;
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: boolean;
  jsonValue?: true;
  location: string;
}

export interface VaultReferenceEntry {
  sentinel: string;
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: false;
  location: string;
}

export interface DataSecretEntry extends SecretBagEntry {
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: true;
}

export interface DataReferenceEntry {
  sentinel: string;
  reference: SecretReference;
  encoding: SecretEncoding;
  dataOrigin: true;
  location: string;
  jsonValue?: true;
}

export type ReferenceOnlyEntry = VaultReferenceEntry | DataReferenceEntry;

export type IssuedSecretBagEntry =
  | VaultReferenceEntry
  | DataSecretEntry
  | DataReferenceEntry;

export type RegistryEntry = IssuedSecretBagEntry | SecretBagEntry;

export function isIssuedEntry(
  entry: RegistryEntry,
): entry is IssuedSecretBagEntry {
  return "reference" in entry;
}

export function isJsonValueEntry(entry: RegistryEntry): boolean {
  return entry.dataOrigin && "jsonValue" in entry && entry.jsonValue === true;
}

/**
 * objects and lists stay JSON text because the redactor matches text; a scalar
 * is parsed only when it prints back as exactly text (8080.0 and 1e3 stay
 * text); non-JSON stays text
 */
export function deliveredJsonValue(text: string): string | number | boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  return (typeof value === "number" || typeof value === "boolean") &&
      String(value) === text
    ? value
    : text;
}

export function holdsValue(
  entry: RegistryEntry,
): entry is SecretBagEntry | DataSecretEntry {
  return "value" in entry;
}

/**
 * every pass of a run issues into one registry and a bag resolves any sentinel
 * it holds, so an earlier pass's sentinel is never delivered as literal text;
 * child runs share the parent's registry
 */
export class SecretBagRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly sequence = new Map<string, number>();
  private readonly prefixes = new Set<string>();
  private readonly existence = new Map<string, Promise<void>>();

  independent(): SecretBagRegistry {
    return new SecretBagRegistry();
  }

  drawPrefix(prefix: string): void {
    this.prefixes.add(prefix);
  }

  /**
   * a confirmation is kept and a rejection dropped so the next caller asks
   * again; authorization is still checked by the caller on every call
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

  entryOf(sentinel: string): RegistryEntry | undefined {
    return this.entries.get(sentinel);
  }

  sequenceOf(sentinel: string): number | undefined {
    return this.sequence.get(sentinel);
  }

  issuedEntryOf(sentinel: string): IssuedSecretBagEntry | undefined {
    const entry = this.entries.get(sentinel);
    return entry && isIssuedEntry(entry) ? entry : undefined;
  }

  drewPrefixOf(sentinel: string): boolean {
    const parts = SENTINEL_PARTS.exec(sentinel);
    return parts !== null && this.prefixes.has(parts[1]);
  }

  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  all(): IterableIterator<RegistryEntry> {
    return this.entries.values();
  }
}
