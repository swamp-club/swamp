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

import { assertEquals } from "@std/assert";
import { verifyProof } from "./proof_verifier.ts";
import {
  base64urlEncode,
  canonicalJson,
  computeProofFingerprint,
  type ProofPayload,
} from "./verification_proof.ts";

async function generateTestKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKeyB64: string;
  kid: string;
}> {
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKeyB64: base64urlEncode(new Uint8Array(rawPublic)),
    kid: "test-kid-1",
  };
}

async function signTestProof(
  payload: ProofPayload,
  privateKey: CryptoKey,
): Promise<{ proofJson: string; signatureB64: string }> {
  const proofJson = canonicalJson(
    payload as unknown as Record<string, unknown>,
  );
  const data = new TextEncoder().encode(proofJson);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, data);
  return {
    proofJson,
    signatureB64: base64urlEncode(new Uint8Array(signature)),
  };
}

const TEST_API_KEY = "swamp_test_key_for_verification";

Deno.test("verifyProof: accepts valid proof", async () => {
  const keys = await generateTestKeyPair();
  const fpr = await computeProofFingerprint(TEST_API_KEY);
  const payload: ProofPayload = {
    fpr,
    iat: Math.floor(Date.now() / 1000),
    kid: keys.kid,
    org: ["test-collective"],
    scopes: ["vault:*"],
    sub: "user-123",
  };
  const { proofJson, signatureB64 } = await signTestProof(
    payload,
    keys.privateKey,
  );

  const result = await verifyProof(
    proofJson,
    signatureB64,
    [{ kid: keys.kid, key: keys.publicKeyB64 }],
    TEST_API_KEY,
  );
  assertEquals(result.valid, true);
  if (result.valid) {
    assertEquals(result.sub, "user-123");
    assertEquals(result.org, ["test-collective"]);
    assertEquals(result.scopes, ["vault:*"]);
  }
});

Deno.test("verifyProof: rejects expired proof", async () => {
  const keys = await generateTestKeyPair();
  const fpr = await computeProofFingerprint(TEST_API_KEY);
  const payload: ProofPayload = {
    exp: Math.floor(Date.now() / 1000) - 3600,
    fpr,
    iat: Math.floor(Date.now() / 1000) - 7200,
    kid: keys.kid,
    org: [],
    scopes: [],
    sub: "user-1",
  };
  const { proofJson, signatureB64 } = await signTestProof(
    payload,
    keys.privateKey,
  );

  const result = await verifyProof(
    proofJson,
    signatureB64,
    [{ kid: keys.kid, key: keys.publicKeyB64 }],
    TEST_API_KEY,
  );
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "proof expired");
});

Deno.test("verifyProof: rejects fingerprint mismatch", async () => {
  const keys = await generateTestKeyPair();
  const fpr = await computeProofFingerprint(TEST_API_KEY);
  const payload: ProofPayload = {
    fpr,
    iat: Math.floor(Date.now() / 1000),
    kid: keys.kid,
    org: [],
    scopes: [],
    sub: "user-1",
  };
  const { proofJson, signatureB64 } = await signTestProof(
    payload,
    keys.privateKey,
  );

  const result = await verifyProof(
    proofJson,
    signatureB64,
    [{ kid: keys.kid, key: keys.publicKeyB64 }],
    "different_api_key",
  );
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "fingerprint mismatch");
});

Deno.test("verifyProof: rejects wrong signature", async () => {
  const keys = await generateTestKeyPair();
  const otherKeys = await generateTestKeyPair();
  const fpr = await computeProofFingerprint(TEST_API_KEY);
  const payload: ProofPayload = {
    fpr,
    iat: Math.floor(Date.now() / 1000),
    kid: keys.kid,
    org: [],
    scopes: [],
    sub: "user-1",
  };
  const { proofJson } = await signTestProof(payload, keys.privateKey);
  const { signatureB64: wrongSig } = await signTestProof(
    payload,
    otherKeys.privateKey,
  );

  const result = await verifyProof(
    proofJson,
    wrongSig,
    [{ kid: keys.kid, key: keys.publicKeyB64 }],
    TEST_API_KEY,
  );
  assertEquals(result.valid, false);
  if (!result.valid) {
    assertEquals(result.reason, "signature verification failed");
  }
});

Deno.test("verifyProof: rejects missing kid", async () => {
  const keys = await generateTestKeyPair();
  const fpr = await computeProofFingerprint(TEST_API_KEY);
  const payload: ProofPayload = {
    fpr,
    iat: Math.floor(Date.now() / 1000),
    kid: "unknown-kid",
    org: [],
    scopes: [],
    sub: "user-1",
  };
  const { proofJson, signatureB64 } = await signTestProof(
    payload,
    keys.privateKey,
  );

  const result = await verifyProof(
    proofJson,
    signatureB64,
    [{ kid: keys.kid, key: keys.publicKeyB64 }],
    TEST_API_KEY,
  );
  assertEquals(result.valid, false);
});

Deno.test("verifyProof: accepts proof without exp (CI signin token)", async () => {
  const keys = await generateTestKeyPair();
  const fpr = await computeProofFingerprint(TEST_API_KEY);
  const payload: ProofPayload = {
    fpr,
    iat: Math.floor(Date.now() / 1000) - 86400 * 30,
    kid: keys.kid,
    org: ["ci-collective"],
    scopes: ["vault:*", "serve:*"],
    sub: "collective-id",
  };
  const { proofJson, signatureB64 } = await signTestProof(
    payload,
    keys.privateKey,
  );

  const result = await verifyProof(
    proofJson,
    signatureB64,
    [{ kid: keys.kid, key: keys.publicKeyB64 }],
    TEST_API_KEY,
  );
  assertEquals(result.valid, true);
});

Deno.test("verifyProof: supports key rotation with multiple keys", async () => {
  const oldKeys = await generateTestKeyPair();
  const newKeys = await generateTestKeyPair();
  const fpr = await computeProofFingerprint(TEST_API_KEY);
  const payload: ProofPayload = {
    fpr,
    iat: Math.floor(Date.now() / 1000),
    kid: oldKeys.kid,
    org: [],
    scopes: [],
    sub: "user-1",
  };
  const { proofJson, signatureB64 } = await signTestProof(
    payload,
    oldKeys.privateKey,
  );

  const result = await verifyProof(
    proofJson,
    signatureB64,
    [
      { kid: oldKeys.kid, key: oldKeys.publicKeyB64 },
      { kid: "new-kid", key: newKeys.publicKeyB64 },
    ],
    TEST_API_KEY,
  );
  assertEquals(result.valid, true);
});

Deno.test("verifyProof: rejects malformed proof JSON", async () => {
  const result = await verifyProof(
    "not valid json",
    "AAAA",
    [],
    TEST_API_KEY,
  );
  assertEquals(result.valid, false);
  if (!result.valid) assertEquals(result.reason, "malformed proof payload");
});
