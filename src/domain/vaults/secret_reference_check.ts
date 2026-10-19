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

import type {
  SecretBagRegistry,
  SecretReference,
} from "./secret_bag_registry.ts";
import {
  secretReferenceError,
  SecretReferenceUnavailableError,
} from "./secret_reference_errors.ts";
import type { VaultService } from "./vault_service.ts";

/** The audit caller context of a probe read, told apart from a load. */
export const PROBE_PURPOSE = "expression:vault-check";

/** Where a probe's value goes before it is dropped: the run's redactor. */
export interface ProbeRedactor {
  addSecret(value: string): void;
}

/**
 * Checks that a vault.get() reference would load, so a missing or
 * unreadable key fails when the expression is evaluated, where the eager
 * read used to fail it, though nothing reads the value until delivery
 * (design/enablers/typed-secrets.md Section 3.4).
 *
 * Every call authorizes a read of the key under the run's vault access, so
 * a grant revoked mid-run fails the next check. The provider is asked once
 * per run tree, through the registry's existence memo: with
 * `VaultExistenceProvider.has` where the vault offers it, so no value is
 * read, and otherwise with one probe read whose value goes to the run's
 * redactor and nowhere else. A missing key under `has` fails with
 * `secret_reference_unavailable`; any other failure keeps the text the
 * eager read reported.
 */
export async function checkSecretReference(
  vaultService: VaultService,
  reference: SecretReference,
  options: {
    /** The run's registry, whose memo answers each reference once. */
    registry: SecretBagRegistry;
    /** The run's redactor, for the value a probe reads. */
    redactor?: ProbeRedactor;
    /** The vault.get() call as written, for errors. */
    call: string;
    /** Where the author wrote the call. */
    location: string;
  },
): Promise<void> {
  const { vaultName, key } = reference;
  try {
    await vaultService.authorizeRead(vaultName, key);
    await options.registry.confirmExists(reference, async () => {
      if (vaultService.supportsExistenceCheck(vaultName)) {
        if (!await vaultService.has(vaultName, key)) {
          throw new SecretReferenceUnavailableError(
            reference,
            options.call,
            options.location,
          );
        }
        return;
      }
      const probed = await vaultService.get(vaultName, key, PROBE_PURPOSE);
      options.redactor?.addSecret(probed);
    });
  } catch (error) {
    throw secretReferenceError(
      `Failed to resolve vault expression ${options.call}`,
      error,
    );
  }
}
