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
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { UserError } from "../errors.ts";
import { importAesKey } from "../crypto/aes_gcm.ts";
import {
  classifyTokenKeyRecord,
  parseTokenSecretsKeyMaterial,
  serializeTokenKeyMarker,
  tokenKeyFingerprint,
  type TokenKeyMarker,
  TokenSecretsKeyError,
} from "./token_secrets_key.ts";

function sequentialKey(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => i + 1);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

const marker: TokenKeyMarker = {
  vault: "prod-secrets",
  key: "swamp-token-key",
  fingerprint: "a".repeat(64),
  migratedAt: "2026-09-25T00:00:00.000Z",
};

Deno.test("parseTokenSecretsKeyMaterial: decodes a 64-char hex key", () => {
  const key = sequentialKey();
  assertEquals(parseTokenSecretsKeyMaterial(toHex(key)), key);
});

Deno.test("parseTokenSecretsKeyMaterial: decodes a base64 key and ignores surrounding whitespace", () => {
  const key = sequentialKey();
  assertEquals(parseTokenSecretsKeyMaterial(`  ${toBase64(key)}\n`), key);
});

Deno.test("parseTokenSecretsKeyMaterial: accepts base64 without its padding", () => {
  const key = sequentialKey();
  const unpadded = toBase64(key).replace(/=+$/, "");
  assertEquals(unpadded.length, 43);
  assertEquals(parseTokenSecretsKeyMaterial(unpadded), key);
});

Deno.test("parseTokenSecretsKeyMaterial: errors are TokenSecretsKeyErrors, including misplaced padding", () => {
  for (const value of ["A", "AAAAA="]) {
    assertThrows(
      () => parseTokenSecretsKeyMaterial(value),
      TokenSecretsKeyError,
      "not valid hex or base64",
    );
  }
});

Deno.test("parseTokenSecretsKeyMaterial: rejects base64 that decodes to the wrong length", () => {
  const err = assertThrows(
    () => parseTokenSecretsKeyMaterial(toBase64(new Uint8Array(16).fill(7))),
    UserError,
  );
  assertStringIncludes(err.message, "got 16");
});

Deno.test("parseTokenSecretsKeyMaterial: rejects values that are neither hex nor base64 without echoing them", () => {
  const value = "not a key!";
  const err = assertThrows(
    () => parseTokenSecretsKeyMaterial(value),
    UserError,
  );
  assertStringIncludes(err.message, "not valid hex or base64");
  assert(!err.message.includes(value));
});

Deno.test("parseTokenSecretsKeyMaterial: rejects a key with the same value in every byte", () => {
  for (const fill of [0, 0xab]) {
    assertThrows(
      () =>
        parseTokenSecretsKeyMaterial(toBase64(new Uint8Array(32).fill(fill))),
      UserError,
      "same value in every byte",
    );
  }
});

Deno.test("parseTokenSecretsKeyMaterial: error for a wrong-length key never includes the value", () => {
  const value = toBase64(Uint8Array.from({ length: 24 }, (_, i) => i));
  const err = assertThrows(() => parseTokenSecretsKeyMaterial(value));
  assert(!(err as Error).message.includes(value));
});

Deno.test("tokenKeyFingerprint: is stable for a key and differs between keys", async () => {
  const key = sequentialKey();
  const other = sequentialKey();
  other[0] = 99;
  const fp = await tokenKeyFingerprint(key);
  assertEquals(fp, await tokenKeyFingerprint(new Uint8Array(key)));
  assertNotEquals(fp, await tokenKeyFingerprint(other));
  assert(/^[0-9a-f]{64}$/.test(fp));
  assert(!fp.includes(toHex(key)));
});

Deno.test("classifyTokenKeyRecord: null is absent", () => {
  assertEquals(classifyTokenKeyRecord(null), { kind: "absent" });
});

Deno.test("classifyTokenKeyRecord: 32 raw bytes is the legacy co-located key", () => {
  const key = sequentialKey();
  assertEquals(classifyTokenKeyRecord(key), { kind: "legacy", key });
});

Deno.test("classifyTokenKeyRecord: round-trips a serialized marker", () => {
  assertEquals(
    classifyTokenKeyRecord(serializeTokenKeyMarker(marker)),
    { kind: "marker", marker },
  );
});

Deno.test("classifyTokenKeyRecord: throws on unrecognized content instead of treating it as absent", () => {
  assertThrows(
    () => classifyTokenKeyRecord(new TextEncoder().encode('{"hello":1}')),
    Error,
    "unrecognized",
  );
  assertThrows(
    () => classifyTokenKeyRecord(new Uint8Array(16)),
    Error,
    "unrecognized",
  );
});

Deno.test("serializeTokenKeyMarker: an older swamp cannot import the marker as an AES key", async () => {
  const bytes = serializeTokenKeyMarker(marker);
  assert(bytes.length > 32);
  let imported = false;
  try {
    await importAesKey(bytes);
    imported = true;
  } catch {
    // expected: AES keys are 16, 24 or 32 bytes
  }
  assertEquals(imported, false);
});
