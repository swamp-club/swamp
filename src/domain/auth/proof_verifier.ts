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
  type ProofPayload,
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
  /** Unix seconds; defaults to the wall clock. */
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProofVerificationResult> {
  const payload = parseProofPayload(proofJson);
  if (!payload) {
    return { valid: false, reason: "malformed proof payload" };
  }

  if (payload.exp !== undefined && payload.exp <= now) {
    return { valid: false, reason: "proof expired" };
  }

  const expectedFpr = await computeProofFingerprint(apiKey);
  if (payload.fpr !== expectedFpr) {
    return { valid: false, reason: "fingerprint mismatch" };
  }

  return await verifySignature(payload, proofJson, signatureB64, publicKeys);
}

export interface ProofSignatureOptions {
  /** Unix seconds; defaults to the wall clock. */
  readonly now?: number;
  /** Accept a proof past its `exp`. */
  readonly ignoreExpiry?: boolean;
}

export type ProofSignatureResult =
  | { readonly valid: true; readonly payload: ProofPayload }
  | { readonly valid: false; readonly reason: string };

/**
 * Verify that swamp-club signed a proof, without the API key it was issued
 * for: the payload shape, its `exp` (unless `ignoreExpiry`) and the Ed25519
 * signature. The fingerprint is not checked, so a valid result shows only
 * that swamp-club issued the proof to an account, not that the caller holds
 * its key. {@link verifyProof} adds that check.
 */
export async function verifyProofSignature(
  proofJson: string,
  signatureB64: string,
  publicKeys: PublicKeyEntry[],
  options: ProofSignatureOptions = {},
): Promise<ProofSignatureResult> {
  const payload = parseProofPayload(proofJson);
  if (!payload) {
    return { valid: false, reason: "malformed proof payload" };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (
    !options.ignoreExpiry && payload.exp !== undefined && payload.exp <= now
  ) {
    return { valid: false, reason: "proof expired" };
  }

  const result = await verifySignature(
    payload,
    proofJson,
    signatureB64,
    publicKeys,
  );
  return result.valid ? { valid: true, payload } : result;
}

async function verifySignature(
  payload: ProofPayload,
  proofJson: string,
  signatureB64: string,
  publicKeys: PublicKeyEntry[],
): Promise<ProofVerificationResult> {
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
