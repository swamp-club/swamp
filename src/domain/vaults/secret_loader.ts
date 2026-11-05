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

export const LOAD_PURPOSE = "expression:vault-resolve";

export interface SecretRead {
  reference: SecretReference;
  location: string;
}

export function secretReadKey(reference: SecretReference): string {
  return `${reference.vaultName}\u0000${reference.key}`;
}

/**
 * answers a value for every reference keyed by secretReadKey, or throws naming
 * the reference that failed, never a value
 */
export interface SecretValueSource {
  read(reads: readonly SecretRead[]): Promise<ReadonlyMap<string, string>>;
}

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
            reference,
          );
        }
      }
      return values;
    },
  };
}

/**
 * reads through VaultService.get inside the run's ambient vault access, so
 * grants and the workflow's vaults: list apply and a sentinel is never a grant
 */
export class SecretLoader {
  #source: SecretValueSource;
  readonly #redactor?: ProbeRedactor;

  constructor(
    vaultService: () => Promise<VaultService>,
    redactor?: ProbeRedactor,
  ) {
    this.#source = vaultServiceSource(vaultService);
    this.#redactor = redactor;
  }

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
   * a failed read throws before anything is delivered, naming the vault, key
   * and location, never a value
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
