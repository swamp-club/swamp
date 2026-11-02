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

export const PROBE_PURPOSE = "expression:vault-check";

export interface ProbeRedactor {
  addSecret(value: string): void;
}

/**
 * every call authorizes a read under the run's vault access; the provider is
 * asked once per run tree via the registry memo, with has() where offered so no
 * value is read, else one probe whose value goes to the redactor
 */
export async function checkSecretReference(
  vaultService: VaultService,
  reference: SecretReference,
  options: {
    registry: SecretBagRegistry;
    redactor?: ProbeRedactor;
    call: string;
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
      `Failed to resolve vault expression ${options.call} (at ${options.location})`,
      error,
    );
  }
}
