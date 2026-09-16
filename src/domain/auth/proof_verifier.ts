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

import { EMBEDDED_PUBLIC_KEY } from "./embedded_public_key.ts";
import {
  base64urlDecode,
  computeProofFingerprint,
  parseProofPayload,
  type PublicKeyEntry,
} from "./verification_proof.ts";

export type ProofVerificationResult =
  | { valid: true; sub: string; org: string[]; scopes: string[] }
  | { valid: false; reason: string };

export async function verifyProof(
  proofJson: string,
  signatureB64: string,
  publicKeys: PublicKeyEntry[],
  apiKey: string,
): Promise<ProofVerificationResult> {
  const payload = parseProofPayload(proofJson);
  if (!payload) {
    return { valid: false, reason: "malformed proof payload" };
  }

  if (
    payload.exp !== undefined && payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    return { valid: false, reason: "proof expired" };
  }

  const expectedFpr = await computeProofFingerprint(apiKey);
  if (payload.fpr !== expectedFpr) {
    return { valid: false, reason: "fingerprint mismatch" };
  }

  const keysToTry = resolvePublicKeys(payload.kid, publicKeys);
  if (keysToTry.length === 0) {
    return { valid: false, reason: "no matching public key for kid" };
  }

  for (const keyB64 of keysToTry) {
    try {
      const keyBytes = base64urlDecode(keyB64);
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyBytes.buffer as ArrayBuffer,
        "Ed25519",
        false,
        ["verify"],
      );
      const data = new TextEncoder().encode(proofJson);
      const signature = base64urlDecode(signatureB64);
      const ok = await crypto.subtle.verify(
        "Ed25519",
        cryptoKey,
        signature.buffer as ArrayBuffer,
        data.buffer as ArrayBuffer,
      );
      if (ok) {
        return {
          valid: true,
          sub: payload.sub,
          org: payload.org,
          scopes: payload.scopes,
        };
      }
    } catch {
      continue;
    }
  }

  return { valid: false, reason: "signature verification failed" };
}

function resolvePublicKeys(
  kid: string,
  publicKeys: PublicKeyEntry[],
): string[] {
  const matched = publicKeys
    .filter((k) => k.kid === kid)
    .map((k) => k.key);

  if (matched.length > 0) return matched;

  if (EMBEDDED_PUBLIC_KEY) {
    return [EMBEDDED_PUBLIC_KEY];
  }

  return [];
}
