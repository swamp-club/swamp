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

import { computeChecksum } from "../models/checksum.ts";

/**
 * A single file's contribution to the installed-extension digest.
 *
 * `relPath` is the file's path relative to the per-extension root, using
 * forward slashes regardless of OS. `contentSha` is the hex-encoded SHA-256
 * of the file's raw bytes. Infrastructure code produces these entries; the
 * domain rolls them up into a single digest.
 */
export interface InstalledExtensionDigestEntry {
  relPath: string;
  contentSha: string;
}

/**
 * Rolls a set of per-file SHA-256 hashes into a single stable digest.
 *
 * Determinism: entries are sorted by relPath, then encoded as lines of
 * `<relPath>\0<contentSha>\n` and hashed. Sorting guarantees stability
 * regardless of the order callers pass entries in; the NUL separator
 * prevents path/content ambiguity for paths containing newlines.
 *
 * Pure: no filesystem access. Infrastructure reads files and produces
 * entries; this function combines them.
 */
export async function computeInstalledExtensionDigest(
  entries: InstalledExtensionDigestEntry[],
): Promise<string> {
  const sorted = [...entries].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
  );
  const encoder = new TextEncoder();
  const lines = sorted.map((e) => `${e.relPath}\0${e.contentSha}\n`);
  return await computeChecksum(encoder.encode(lines.join("")));
}
