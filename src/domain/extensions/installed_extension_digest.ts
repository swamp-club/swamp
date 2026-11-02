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

import { computeChecksum } from "../models/checksum.ts";

export interface InstalledExtensionDigestEntry {
  relPath: string;
  contentSha: string;
}

/**
 * sorted by relPath so the digest is stable regardless of caller order; the NUL
 * separator prevents path/content ambiguity for paths containing newlines
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
