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

export interface ProofPayload {
  exp?: number;
  fpr: string;
  iat: number;
  kid: string;
  org: string[];
  scopes: string[];
  sub: string;
}

export interface PublicKeyEntry {
  kid: string;
  key: string;
}

export interface VerificationProof {
  verificationProof: string;
  verificationSignature: string;
  publicKeys: PublicKeyEntry[];
}

export interface CachedVerification {
  proof: string;
  signature: string;
  publicKeys: PublicKeyEntry[];
  cachedAt: string;
}

export function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export function base64urlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function computeProofFingerprint(
  apiKey: string,
): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parseProofPayload(
  proofJson: string,
): ProofPayload | undefined {
  try {
    const parsed = JSON.parse(proofJson);
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof parsed.fpr !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.kid !== "string" ||
      typeof parsed.sub !== "string" ||
      !Array.isArray(parsed.org) ||
      !Array.isArray(parsed.scopes)
    ) {
      return undefined;
    }
    return parsed as ProofPayload;
  } catch {
    return undefined;
  }
}
