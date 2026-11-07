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

export const SECRET_NOT_FOUND_CODE = "secret_not_found";

export interface SecretNotFoundErrorOptions {
  message?: string;
  cause?: unknown;
}

/** a vault store raises this from get() only when the key is absent */
export class SecretNotFoundError extends UserError {
  constructor(
    readonly vaultName: string,
    readonly key: string,
    options?: SecretNotFoundErrorOptions,
  ) {
    super(
      options?.message ?? `Secret '${key}' not found in vault '${vaultName}'`,
      SECRET_NOT_FOUND_CODE,
    );
    this.name = "SecretNotFoundError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * matches the error's own code, never instanceof or its cause chain: a store
 * may wrap some other secret's absence, which must not relabel this read
 */
export function isSecretNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === SECRET_NOT_FOUND_CODE;
}
