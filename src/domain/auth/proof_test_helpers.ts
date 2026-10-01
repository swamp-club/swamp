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

// Test-only helpers for minting verification proofs signed by a throwaway
// Ed25519 key. The gate trusts the public keys cached alongside a proof, so
// a proof minted here verifies through the normal code path — no switch in
// the product is needed to test it.

import {
  base64urlEncode,
  canonicalJson,
  computeProofFingerprint,
  type PublicKeyEntry,
} from "./verification_proof.ts";

export interface TestSigningKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: PublicKeyEntry;
}

export async function generateTestSigningKey(
  kid = `test-${crypto.randomUUID()}`,
): Promise<TestSigningKey> {
  const pair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: { kid, key: base64urlEncode(new Uint8Array(raw)) },
  };
}

export interface MintedProof {
  readonly proof: string;
  readonly signature: string;
  readonly publicKeys: PublicKeyEntry[];
}

/** Mint a proof for `apiKey`, issued at `iat` and expiring at `exp`. */
export async function mintTestProof(
  key: TestSigningKey,
  apiKey: string,
  options: { iat: number; exp?: number; sub?: string },
): Promise<MintedProof> {
  const payload: Record<string, unknown> = {
    fpr: await computeProofFingerprint(apiKey),
    iat: options.iat,
    kid: key.publicKey.kid,
    org: [],
    scopes: [],
    sub: options.sub ?? "test-user",
  };
  if (options.exp !== undefined) payload.exp = options.exp;
  const proof = canonicalJson(payload);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.privateKey,
    new TextEncoder().encode(proof),
  );
  return {
    proof,
    signature: base64urlEncode(new Uint8Array(signature)),
    publicKeys: [key.publicKey],
  };
}

/** Encode a proof as a SWAMP_SIGNIN_TOKEN value (`<proof>.<signature>`). */
export function toSigninToken(minted: MintedProof): string {
  return `${
    base64urlEncode(new TextEncoder().encode(minted.proof))
  }.${minted.signature}`;
}
