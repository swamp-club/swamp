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

import { timingSafeEqual } from "../crypto/timing_safe_equal.ts";
import { generateOpaqueToken } from "../remote/session_credential.ts";

export const DELEGATED_ACCESS_PREFIX = "swda1";
export const DELEGATED_REFRESH_PREFIX = "swdr1";
export const DELEGATION_REDEEM_PREFIX = "swdx1";

/**
 * names no server token may take: an older node splits a delegated token at its
 * first dot and looks up a server token by that name, which must never exist
 */
export const RESERVED_TOKEN_NAMES: readonly string[] = [
  DELEGATED_ACCESS_PREFIX,
  DELEGATED_REFRESH_PREFIX,
  DELEGATION_REDEEM_PREFIX,
  "swi1",
];

export type DelegatedSecretKind = "access" | "refresh" | "redeem";

const PREFIX_OF: Record<DelegatedSecretKind, string> = {
  access: DELEGATED_ACCESS_PREFIX,
  refresh: DELEGATED_REFRESH_PREFIX,
  redeem: DELEGATION_REDEEM_PREFIX,
};

const DELEGATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDelegationId(id: string): boolean {
  return DELEGATION_ID_PATTERN.test(id);
}

export interface ParsedDelegatedSecret {
  readonly kind: DelegatedSecretKind;
  readonly delegationId: string;
}

export interface IssuedSecret {
  readonly value: string;
  readonly hash: string;
}

/** a long random secret needs no slow hash: there is nothing to guess */
export async function delegatedSecretHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

export async function issueDelegatedSecret(
  kind: DelegatedSecretKind,
  delegationId: string,
): Promise<IssuedSecret> {
  if (!isDelegationId(delegationId)) {
    throw new Error(`Not a delegation id: ${delegationId}`);
  }
  const value = `${PREFIX_OF[kind]}.${delegationId}.${generateOpaqueToken()}`;
  return { value, hash: await delegatedSecretHash(value) };
}

/** null for anything that is not exactly one of the three shapes */
export function parseDelegatedSecret(
  presented: string,
): ParsedDelegatedSecret | null {
  const parts = presented.split(".");
  if (parts.length !== 3) return null;
  const kind = (Object.keys(PREFIX_OF) as DelegatedSecretKind[]).find((k) =>
    PREFIX_OF[k] === parts[0]
  );
  if (kind === undefined) return null;
  if (!isDelegationId(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) {
    return null;
  }
  return { kind, delegationId: parts[1] };
}

/** the prefix alone, so a malformed delegated token is never tried as a server token */
export function delegatedSecretKindOf(
  presented: string,
): DelegatedSecretKind | null {
  const prefix = presented.split(".", 1)[0];
  const kind = (Object.keys(PREFIX_OF) as DelegatedSecretKind[]).find((k) =>
    PREFIX_OF[k] === prefix
  );
  return kind ?? null;
}

export async function delegatedSecretMatches(
  presented: string,
  storedHash: string | undefined,
): Promise<boolean> {
  if (storedHash === undefined) return false;
  return timingSafeEqual(storedHash, await delegatedSecretHash(presented));
}
