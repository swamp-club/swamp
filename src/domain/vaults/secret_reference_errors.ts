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
import { VaultAccessDeniedError } from "./run_vault_access.ts";
import type { SecretReference } from "./secret_bag_registry.ts";

/**
 * A vault.get() reference names a key its vault does not hold, as the
 * vault's existence check answers it. The message names the vault, the key
 * and where the reference is written, never a value.
 */
export class SecretReferenceUnavailableError extends UserError {
  constructor(
    readonly reference: SecretReference,
    call: string,
    location: string,
  ) {
    super(
      `Failed to resolve vault expression ${call}: Secret '${reference.key}' not found in vault '${reference.vaultName}' (at ${location})`,
      "secret_reference_unavailable",
    );
    this.name = "SecretReferenceUnavailableError";
  }
}

/**
 * The error a vault reference fails with, `context` saying which reference
 * and where: a refusal by the run's vault access keeps its
 * `vault_access_denied` code, and any other error keeps its text, on one
 * line, as the eager read reported it. A missing key is already its own.
 */
export function secretReferenceError(context: string, error: unknown): Error {
  if (error instanceof SecretReferenceUnavailableError) return error;
  const message = `${context}: ${
    (error instanceof Error ? error.message : String(error))
      .replace(/\n\s*/g, " — ")
  }`;
  return error instanceof VaultAccessDeniedError
    ? new UserError(message, error.code)
    : new Error(message);
}
