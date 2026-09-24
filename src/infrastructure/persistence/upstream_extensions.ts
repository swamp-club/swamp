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

/** Entry in upstream_extensions.json. */
export interface UpstreamExtensionEntry {
  version: string;
  pulledAt: string;
  files?: string[];
  include?: string[];
  /** SHA-256 checksum of the extension archive, for verification on re-install. */
  checksum?: string;
  /**
   * Rolled-up SHA-256 digest of the on-disk per-extension subtree at install
   * time. Distinct from `checksum` (which hashes the archive bytes): this
   * anchors the EXTRACTED files so auto-update can detect local edits
   * before overwriting. Absent on pre-anchor lockfile entries (grandfather
   * path) — consumers must tolerate the missing value.
   */
  filesChecksum?: string;
  /** Registry server URL used when pulling, for non-default registries. */
  serverUrl?: string;
  /**
   * Release channel the extension was installed from. Absent on pre-channel
   * lockfile entries — consumers default to "stable" when missing.
   */
  channel?: string;
}

/** Shape of upstream_extensions.json. */
export type UpstreamExtensionsMap = Record<string, UpstreamExtensionEntry>;

/**
 * Reads upstream_extensions.json and returns the parsed map. A missing file
 * reads as an empty map.
 *
 * Content that is not valid JSON, or is valid JSON but not an object (such
 * as `null` or an array), throws a `SyntaxError` naming the file, so callers
 * treat both as the same corrupt lockfile.
 *
 * @param lockfilePath Full path to the upstream_extensions.json file.
 */
export async function readUpstreamExtensions(
  lockfilePath: string,
): Promise<UpstreamExtensionsMap> {
  let content: string;
  try {
    content = await Deno.readTextFile(lockfilePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new SyntaxError(
      `Cannot parse lockfile ${lockfilePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const found = parsed === null
      ? "null"
      : Array.isArray(parsed)
      ? "an array"
      : typeof parsed;
    throw new SyntaxError(
      `Lockfile ${lockfilePath} must contain a JSON object, found ${found}`,
    );
  }
  return parsed as UpstreamExtensionsMap;
}
