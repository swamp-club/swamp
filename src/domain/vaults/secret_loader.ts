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
  holdsValue,
  isIssuedEntry,
  type ReferenceOnlyEntry,
  type SecretReference,
} from "./secret_bag_registry.ts";
import { secretReferenceError } from "./secret_reference_errors.ts";
import type { ProbeRedactor } from "./secret_reference_check.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";
import type { VaultService } from "./vault_service.ts";

/** The audit caller context of a load: a read for delivery. */
export const LOAD_PURPOSE = "expression:vault-resolve";

/** One reference a load reads, and where it is written, for its errors. */
export interface SecretRead {
  reference: SecretReference;
  location: string;
}

/** The key a {@link SecretValueSource} answers a reference's value under. */
export function secretReadKey(reference: SecretReference): string {
  return `${reference.vaultName}\u0000${reference.key}`;
}

/**
 * Where a load reads its values from. It is handed each distinct reference
 * of one attempt once, in order of first occurrence, and answers a value for
 * every one keyed by {@link secretReadKey}, or throws naming the reference
 * that failed and never a value.
 */
export interface SecretValueSource {
  read(reads: readonly SecretRead[]): Promise<ReadonlyMap<string, string>>;
}

/**
 * The source a run in this process reads through: `VaultService.get`, one
 * reference at a time, inside the run's ambient vault access.
 */
function vaultServiceSource(
  vaultService: () => Promise<VaultService>,
): SecretValueSource {
  return {
    async read(reads) {
      const service = await vaultService();
      const values = new Map<string, string>();
      for (const { reference, location } of reads) {
        const { vaultName, key } = reference;
        try {
          values.set(
            secretReadKey(reference),
            await service.get(vaultName, key, LOAD_PURPOSE),
          );
        } catch (error) {
          throw secretReferenceError(
            `Failed to load secret '${key}' from vault '${vaultName}' (at ${location})`,
            error,
          );
        }
      }
      return values;
    },
  };
}

/**
 * Loads secret values at delivery (design/enablers/typed-secrets.md
 * Section 3.3). Sentinels stand for references, and nothing reads a value
 * until a trusted consumer receives it: a method's arguments, its
 * pre-flight checks, the shell environment, a remote dispatch, or one of
 * the inline destinations that take a value today. A vault.get() reference
 * and a sensitive-field reference a typed data read issued (typed-secrets
 * 3.3) load alike; a legacy data entry already holds its value.
 *
 * In process each load reads through `VaultService.get`, inside the run's
 * ambient vault access, so the principal's grants and the workflow's
 * `vaults:` list apply and a sentinel is never a grant. It reads through the
 * same vault service the existence check asked, so a refresh hook refreshes
 * on load as it did on the eager read. A protocol version 6 runner reads
 * through the dispatch's protected load route instead ({@link fromSource}).
 * Either way a load reads each distinct reference once per attempt, and
 * each value goes to the run's redactor.
 */
export class SecretLoader {
  #source: SecretValueSource;
  readonly #redactor?: ProbeRedactor;

  constructor(
    /** The vault service to read through, resolved on first use. */
    vaultService: () => Promise<VaultService>,
    /** The run's redactor, which learns each loaded value. */
    redactor?: ProbeRedactor,
  ) {
    this.#source = vaultServiceSource(vaultService);
    this.#redactor = redactor;
  }

  /** A loader that reads through `source` rather than a vault service. */
  static fromSource(
    source: SecretValueSource,
    redactor?: ProbeRedactor,
  ): SecretLoader {
    const loader = new SecretLoader(
      () => Promise.reject(new Error("This loader reads through its source")),
      redactor,
    );
    loader.#source = source;
    return loader;
  }

  /**
   * A delivery view of `bag` that holds a value for every reference-only
   * entry of the run whose sentinel occurs in `data`: one read per distinct
   * reference, for this attempt only. `bag` itself is returned when `data`
   * carries none. A failed read throws before anything is delivered, naming
   * the vault, the key and where the reference is written or was read from,
   * never a value.
   */
  async load(bag: VaultSecretBag, data: unknown): Promise<VaultSecretBag> {
    const references = new Map<string, ReferenceOnlyEntry>();
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(VaultSecretBag.SENTINEL_PATTERN)) {
          const entry = bag.registry.entryOf(match[0]);
          if (entry && isIssuedEntry(entry) && !holdsValue(entry)) {
            references.set(match[0], entry);
          }
        }
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(data);
    if (references.size === 0) return bag;

    const reads = new Map<string, SecretRead>();
    for (const { reference, location } of references.values()) {
      const id = secretReadKey(reference);
      if (!reads.has(id)) reads.set(id, { reference, location });
    }
    const read = await this.#source.read([...reads.values()]);
    const values = new Map<string, string>();
    for (const id of reads.keys()) {
      const value = read.get(id);
      if (value === undefined) {
        // Where the reference is written: an argument or a record field.
        const { reference, location: where } = reads.get(id)!;
        throw new Error(
          `Failed to load secret '${reference.key}' from vault '${reference.vaultName}' (at ${where}): no value was returned`,
        );
      }
      this.#redactor?.addSecret(value);
    }
    for (const [sentinel, { reference }] of references) {
      values.set(sentinel, read.get(secretReadKey(reference))!);
    }
    return bag.withLoaded(values);
  }
}
