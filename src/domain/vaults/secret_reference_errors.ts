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

export class SecretReferenceUnavailableError extends UserError {
  constructor(
    readonly reference: SecretReference,
    call: string,
    location: string,
  ) {
    super(
      `Failed to resolve vault expression ${call} (at ${location}): Secret '${reference.key}' not found in vault '${reference.vaultName}'`,
      "secret_reference_unavailable",
    );
    this.name = "SecretReferenceUnavailableError";
  }
}

/**
 * readResource refuses a record whose sensitive-fields tag the writer could not
 * have produced, rather than guess which fields hold references; the message
 * never includes the tag's text
 */
export class ResourceSensitiveFieldsInvalidError extends UserError {
  constructor(readonly instanceName: string, cause: Error) {
    super(
      `Failed to read sensitive fields of resource '${instanceName}': ${cause.message}`,
      "secret_reference_invalid",
    );
    this.name = "ResourceSensitiveFieldsInvalidError";
    this.cause = cause;
  }
}

/**
 * a vault access refusal keeps its vault_access_denied code; any other error
 * keeps its text on one line; a missing key is already its own error
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
