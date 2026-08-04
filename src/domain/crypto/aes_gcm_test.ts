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

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  exportAesKey,
  generateAesKey,
  importAesKey,
} from "./aes_gcm.ts";

Deno.test("aesGcmEncrypt: round-trips plaintext through encrypt and decrypt", async () => {
  const key = await generateAesKey();
  const plaintext = "hello world secret value";

  const blob = await aesGcmEncrypt(plaintext, key);
  const decrypted = await aesGcmDecrypt(blob, key);

  assertEquals(decrypted, plaintext);
});

Deno.test("aesGcmEncrypt: produces distinct IVs per call", async () => {
  const key = await generateAesKey();
  const plaintext = "same value";

  const blob1 = await aesGcmEncrypt(plaintext, key);
  const blob2 = await aesGcmEncrypt(plaintext, key);

  assertNotEquals(blob1.iv, blob2.iv);
});

Deno.test("aesGcmEncrypt: produces distinct ciphertext per call", async () => {
  const key = await generateAesKey();
  const plaintext = "same value";

  const blob1 = await aesGcmEncrypt(plaintext, key);
  const blob2 = await aesGcmEncrypt(plaintext, key);

  assertNotEquals(blob1.data, blob2.data);
});

Deno.test("aesGcmDecrypt: fails with wrong key", async () => {
  const key1 = await generateAesKey();
  const key2 = await generateAesKey();
  const plaintext = "secret";

  const blob = await aesGcmEncrypt(plaintext, key1);

  let threw = false;
  try {
    await aesGcmDecrypt(blob, key2);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("aesGcmEncrypt: handles empty string", async () => {
  const key = await generateAesKey();
  const blob = await aesGcmEncrypt("", key);
  const decrypted = await aesGcmDecrypt(blob, key);
  assertEquals(decrypted, "");
});

Deno.test("aesGcmEncrypt: handles unicode content", async () => {
  const key = await generateAesKey();
  const plaintext = "hello \u{1F30D} wörld \u{1F389}";
  const blob = await aesGcmEncrypt(plaintext, key);
  const decrypted = await aesGcmDecrypt(blob, key);
  assertEquals(decrypted, plaintext);
});

Deno.test("generateAesKey: exports and re-imports a key that still works", async () => {
  const original = await generateAesKey();
  const exported = await exportAesKey(original);
  assertEquals(exported.byteLength, 32);

  const reimported = await importAesKey(exported);
  const plaintext = "round-trip through export/import";
  const blob = await aesGcmEncrypt(plaintext, original);
  const decrypted = await aesGcmDecrypt(blob, reimported);
  assertEquals(decrypted, plaintext);
});

Deno.test("arrayBufferToBase64: round-trips through base64ToArrayBuffer", () => {
  const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const b64 = arrayBufferToBase64(original);
  const restored = new Uint8Array(base64ToArrayBuffer(b64));
  assertEquals(restored, original);
});
