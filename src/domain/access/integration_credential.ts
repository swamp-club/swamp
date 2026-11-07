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

import { generateOpaqueToken } from "../remote/session_credential.ts";

const CREDENTIAL_PREFIX = "swi1";

export const INTEGRATION_CREDENTIAL_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface GeneratedIntegrationCredential {
  readonly credential: string;
  readonly hash: string;
}

/** a long random secret needs no slow hash: there is nothing to guess */
export async function integrationCredentialHash(
  credential: string,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(credential),
  );
  const hex = Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

/** the prefix keeps a credential from parsing as a <name>.<secret> token */
export async function generateIntegrationCredential(
  id: string,
): Promise<GeneratedIntegrationCredential> {
  const credential = `${CREDENTIAL_PREFIX}.${id}.${generateOpaqueToken()}`;
  return { credential, hash: await integrationCredentialHash(credential) };
}
