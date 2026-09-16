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
import {
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  computeProofFingerprint,
  parseProofPayload,
} from "./verification_proof.ts";

Deno.test("canonicalJson: sorts keys alphabetically", () => {
  const result = canonicalJson({ z: 1, a: 2, m: 3 });
  assertEquals(result, '{"a":2,"m":3,"z":1}');
});

Deno.test("canonicalJson: matches server format for proof payload", () => {
  const payload = {
    fpr: "abc123",
    iat: 1726000000,
    kid: "key-1",
    org: ["swamp-club"],
    scopes: ["vault:*"],
    sub: "user-1",
  };
  const result = canonicalJson(payload);
  assertEquals(
    result,
    '{"fpr":"abc123","iat":1726000000,"kid":"key-1","org":["swamp-club"],"scopes":["vault:*"],"sub":"user-1"}',
  );
});

Deno.test("canonicalJson: handles optional exp field", () => {
  const payload = {
    exp: 1727209600,
    fpr: "abc",
    iat: 1726000000,
    kid: "k1",
    org: [],
    scopes: [],
    sub: "u1",
  };
  const result = canonicalJson(payload);
  const parsed = JSON.parse(result);
  assertEquals(Object.keys(parsed), [
    "exp",
    "fpr",
    "iat",
    "kid",
    "org",
    "scopes",
    "sub",
  ]);
});

Deno.test("base64urlEncode: round-trips with base64urlDecode", () => {
  const original = new TextEncoder().encode("hello world");
  const encoded = base64urlEncode(original);
  const decoded = base64urlDecode(encoded);
  assertEquals(decoded, original);
});

Deno.test("base64urlEncode: produces URL-safe characters", () => {
  const bytes = new Uint8Array([255, 254, 253, 252, 251]);
  const encoded = base64urlEncode(bytes);
  assertEquals(encoded.includes("+"), false);
  assertEquals(encoded.includes("/"), false);
  assertEquals(encoded.includes("="), false);
});

Deno.test("computeProofFingerprint: produces 64-char lowercase hex", async () => {
  const fpr = await computeProofFingerprint("swamp_test_key_123");
  assertEquals(fpr.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(fpr), true);
});

Deno.test("computeProofFingerprint: deterministic", async () => {
  const fpr1 = await computeProofFingerprint("swamp_key_abc");
  const fpr2 = await computeProofFingerprint("swamp_key_abc");
  assertEquals(fpr1, fpr2);
});

Deno.test("computeProofFingerprint: different keys produce different fingerprints", async () => {
  const fpr1 = await computeProofFingerprint("swamp_key_1");
  const fpr2 = await computeProofFingerprint("swamp_key_2");
  assertEquals(fpr1 !== fpr2, true);
});

Deno.test("parseProofPayload: parses valid payload", () => {
  const json = JSON.stringify({
    fpr: "abc",
    iat: 1726000000,
    kid: "k1",
    org: ["club"],
    scopes: ["vault:*"],
    sub: "user-1",
  });
  const result = parseProofPayload(json);
  assertEquals(result?.sub, "user-1");
  assertEquals(result?.fpr, "abc");
});

Deno.test("parseProofPayload: returns undefined for invalid JSON", () => {
  assertEquals(parseProofPayload("not json"), undefined);
});

Deno.test("parseProofPayload: returns undefined for missing required fields", () => {
  assertEquals(parseProofPayload(JSON.stringify({ fpr: "abc" })), undefined);
});

Deno.test("parseProofPayload: accepts payload with optional exp", () => {
  const json = JSON.stringify({
    exp: 1727209600,
    fpr: "abc",
    iat: 1726000000,
    kid: "k1",
    org: [],
    scopes: [],
    sub: "u1",
  });
  const result = parseProofPayload(json);
  assertEquals(result?.exp, 1727209600);
});
