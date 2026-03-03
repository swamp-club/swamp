// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  checksumUrlFromTarballUrl,
  parseChecksumFile,
  validateRedirectUrl,
  verifyChecksum,
} from "./integrity.ts";

// --- validateRedirectUrl tests ---

Deno.test("validateRedirectUrl accepts valid artifacts.systeminit.com URL", () => {
  validateRedirectUrl(
    "https://artifacts.systeminit.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp.tar.gz",
  );
});

Deno.test("validateRedirectUrl rejects non-HTTPS URL", () => {
  assertThrows(
    () =>
      validateRedirectUrl(
        "http://artifacts.systeminit.com/swamp/binary.tar.gz",
      ),
    UserError,
    "Insecure redirect protocol",
  );
});

Deno.test("validateRedirectUrl rejects untrusted host", () => {
  assertThrows(
    () => validateRedirectUrl("https://evil.com/swamp/binary.tar.gz"),
    UserError,
    "Untrusted redirect host",
  );
});

Deno.test("validateRedirectUrl rejects malformed URL", () => {
  assertThrows(
    () => validateRedirectUrl("not-a-url"),
    UserError,
    "Invalid redirect URL",
  );
});

// --- checksumUrlFromTarballUrl tests ---

Deno.test("checksumUrlFromTarballUrl appends .sha256", () => {
  assertEquals(
    checksumUrlFromTarballUrl(
      "https://artifacts.systeminit.com/swamp/v1/binary/darwin/aarch64/swamp.tar.gz",
    ),
    "https://artifacts.systeminit.com/swamp/v1/binary/darwin/aarch64/swamp.tar.gz.sha256",
  );
});

// --- parseChecksumFile tests ---

Deno.test("parseChecksumFile parses standard sha256sum format", () => {
  const content =
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890  swamp.tar.gz\n";
  assertEquals(
    parseChecksumFile(content),
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  );
});

Deno.test("parseChecksumFile handles content without trailing newline", () => {
  const content =
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890  swamp.tar.gz";
  assertEquals(
    parseChecksumFile(content),
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  );
});

Deno.test("parseChecksumFile throws on empty content", () => {
  assertThrows(
    () => parseChecksumFile(""),
    UserError,
    "Checksum file is empty",
  );
});

Deno.test("parseChecksumFile throws on invalid format", () => {
  assertThrows(
    () => parseChecksumFile("not-a-checksum"),
    UserError,
    "Invalid checksum file format",
  );
});

Deno.test("parseChecksumFile throws on short hash", () => {
  assertThrows(
    () => parseChecksumFile("abcdef  swamp.tar.gz"),
    UserError,
    "Invalid checksum file format",
  );
});

// --- verifyChecksum tests ---

Deno.test("verifyChecksum passes for matching checksums", () => {
  const hash =
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
  verifyChecksum(hash, hash);
});

Deno.test("verifyChecksum passes for case-insensitive match", () => {
  verifyChecksum(
    "ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  );
});

Deno.test("verifyChecksum throws on mismatch", () => {
  assertThrows(
    () =>
      verifyChecksum(
        "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        "0000001234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      ),
    UserError,
    "Checksum verification failed",
  );
});
