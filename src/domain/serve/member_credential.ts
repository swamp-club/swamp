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
  isFederationSecret,
  matchesHash,
  newFederationSecret,
  sha256Hex,
} from "./federation_secret.ts";
import { normalizedUuid } from "./instance_id.ts";

/** distinct from server tokens, which split on their first dot */
export const MEMBER_CREDENTIAL_PREFIX = "swfm1";

export class MemberCredentialError extends Error {
  constructor() {
    super("Invalid member credential");
    this.name = "MemberCredentialError";
  }
}

/** swfm1.<memberId>.<secret>; only its sha256 hash is ever stored */
export class MemberCredential {
  readonly #secret: string;

  private constructor(readonly memberId: string, secret: string) {
    this.#secret = secret;
  }

  static issue(memberId: string): MemberCredential {
    const id = normalizedUuid(memberId);
    if (id === undefined) throw new MemberCredentialError();
    return new MemberCredential(id, newFederationSecret());
  }

  /** one refusal for every malformed form, and never an echo of the input */
  static parse(wire: unknown): MemberCredential {
    if (typeof wire !== "string") throw new MemberCredentialError();
    const parts = wire.split(".");
    if (parts.length !== 3 || parts[0] !== MEMBER_CREDENTIAL_PREFIX) {
      throw new MemberCredentialError();
    }
    const memberId = normalizedUuid(parts[1]);
    if (memberId === undefined || parts[1] !== memberId) {
      throw new MemberCredentialError();
    }
    if (!isFederationSecret(parts[2])) throw new MemberCredentialError();
    return new MemberCredential(memberId, parts[2]);
  }

  toWire(): string {
    return `${MEMBER_CREDENTIAL_PREFIX}.${this.memberId}.${this.#secret}`;
  }

  hash(): string {
    return sha256Hex(this.toWire());
  }

  verify(storedHash: string): boolean {
    return matchesHash(this.toWire(), storedHash);
  }

  toString(): string {
    return `${MEMBER_CREDENTIAL_PREFIX}.${this.memberId}.<redacted>`;
  }

  toJSON(): string {
    return this.toString();
  }
}
