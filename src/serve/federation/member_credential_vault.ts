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
  MemberCredential,
  MemberCredentialError,
} from "../../domain/serve/member_credential.ts";
import { SecretNotFoundError } from "../../domain/vaults/secret_not_found_error.ts";

/**
 * the one key the member credential is kept under in the _token-secrets vault;
 * outside the server-token- prefix, so token GC and token health never see it
 */
export const MEMBER_CREDENTIAL_SECRET = "federation-member-credential";

export interface MemberSecretVault {
  get(key: string): Promise<string>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** the only place a member's credential is kept */
export class MemberCredentialVault {
  readonly #vault: MemberSecretVault;

  constructor(vault: MemberSecretVault) {
    this.#vault = vault;
  }

  /** undefined when none is stored, or what is stored is not a credential */
  async read(): Promise<MemberCredential | undefined> {
    let wire: string;
    try {
      wire = await this.#vault.get(MEMBER_CREDENTIAL_SECRET);
    } catch (error) {
      if (error instanceof SecretNotFoundError) return undefined;
      throw error;
    }
    try {
      return MemberCredential.parse(wire);
    } catch (error) {
      if (error instanceof MemberCredentialError) return undefined;
      throw error;
    }
  }

  async store(credential: MemberCredential): Promise<void> {
    await this.#vault.put(MEMBER_CREDENTIAL_SECRET, credential.toWire());
  }

  async delete(): Promise<void> {
    await this.#vault.delete(MEMBER_CREDENTIAL_SECRET);
  }
}
