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

import { UserError } from "../errors.ts";

const TRUSTED_ARTIFACT_HOST = "artifacts.systeminit.com";

/**
 * Validate that a redirect URL points to the trusted artifact host over HTTPS.
 * Throws UserError if the URL is not trusted.
 */
export function validateRedirectUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserError(`Invalid redirect URL: ${url}`);
  }

  if (parsed.protocol !== "https:") {
    throw new UserError(
      `Insecure redirect protocol: ${parsed.protocol}. Expected https:`,
    );
  }

  if (parsed.hostname !== TRUSTED_ARTIFACT_HOST) {
    throw new UserError(
      `Untrusted redirect host: ${parsed.hostname}. Expected ${TRUSTED_ARTIFACT_HOST}`,
    );
  }
}

/**
 * Derive the checksum URL from a tarball URL by appending ".sha256".
 */
export function checksumUrlFromTarballUrl(tarballUrl: string): string {
  return `${tarballUrl}.sha256`;
}

/**
 * Parse a sha256sum-format checksum file and return the hex digest.
 * Expected format: "<hex_hash>  <filename>"
 * Throws UserError if the format is invalid.
 */
export function parseChecksumFile(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new UserError("Checksum file is empty");
  }

  const match = trimmed.match(/^([0-9a-f]{64})\s{1,2}\S+$/);
  if (!match) {
    throw new UserError("Invalid checksum file format");
  }

  return match[1];
}

/**
 * Verify that a computed checksum matches the expected checksum.
 * Throws UserError on mismatch.
 */
export function verifyChecksum(expected: string, actual: string): void {
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new UserError(
      `Checksum verification failed. Expected ${expected}, got ${actual}. ` +
        `The downloaded file may have been tampered with.`,
    );
  }
}
