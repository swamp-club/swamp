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
  type VaultReferenceEntry,
} from "./secret_bag_registry.ts";
import { secretReferenceError } from "./secret_reference_errors.ts";
import type { ProbeRedactor } from "./secret_reference_check.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";
import type { VaultService } from "./vault_service.ts";

/** The audit caller context of a load: a read for delivery. */
export const LOAD_PURPOSE = "expression:vault-resolve";

/**
 * Loads vault.get() values at delivery (design/enablers/typed-secrets.md
 * Section 3.3). Sentinels stand for references, and nothing reads a value
 * until a trusted consumer receives it: a method's arguments, its
 * pre-flight checks, the shell environment, a remote dispatch, or one of
 * the inline destinations that take a value today.
 *
 * Each load reads through `VaultService.get`, inside the run's ambient vault
 * access, so the principal's grants and the workflow's `vaults:` list apply
 * and a sentinel is never a grant. It reads through the same vault service
 * the existence check asked, so a refresh hook refreshes on load as it did
 * on the eager read. Each value goes to the run's redactor.
 */
export class SecretLoader {
  constructor(
    /** The vault service to read through, resolved on first use. */
    private readonly vaultService: () => Promise<VaultService>,
    /** The run's redactor, which learns each loaded value. */
    private readonly redactor?: ProbeRedactor,
  ) {}

  /**
   * A delivery view of `bag` that holds a value for every vault reference
   * of the run whose sentinel occurs in `data`: one read per distinct
   * reference, for this attempt only. `bag` itself is returned when `data`
   * carries none. A failed read throws before anything is delivered, naming
   * the vault, the key and where the reference is written, never a value.
   */
  async load(bag: VaultSecretBag, data: unknown): Promise<VaultSecretBag> {
    const references = new Map<string, VaultReferenceEntry>();
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(VaultSecretBag.SENTINEL_PATTERN)) {
          const entry = bag.registry.entryOf(match[0]);
          if (entry && isIssuedEntry(entry) && !entry.dataOrigin) {
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

    const vaultService = await this.vaultService();
    const read = new Map<string, string>();
    const values = new Map<string, string>();
    for (const [sentinel, { reference, location }] of references) {
      const { vaultName, key } = reference;
      const id = `${vaultName}\u0000${key}`;
      let value = read.get(id);
      if (value === undefined) {
        try {
          value = await vaultService.get(vaultName, key, LOAD_PURPOSE);
        } catch (error) {
          throw secretReferenceError(
            `Failed to load secret '${key}' from vault '${vaultName}' (at ${location})`,
            error,
          );
        }
        this.redactor?.addSecret(value);
        read.set(id, value);
      }
      values.set(sentinel, value);
    }
    return bag.withLoaded(values);
  }
}
