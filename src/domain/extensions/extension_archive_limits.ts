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

const MIB = 1024 * 1024;

/**
 * Largest compressed extension archive (`.tar.gz`) that push will send and
 * pull will accept.
 *
 * The registry enforces no size at publish time. Its only ceiling is the
 * scoring analyzer's `MAX_TARBALL_BYTES` (swamp-club
 * `lib/infrastructure/extension-tarball-analyzer.ts`), so this matches it:
 * every archive the registry can score still installs.
 */
export const MAX_EXTENSION_ARCHIVE_BYTES = 50 * MIB;

/**
 * Largest decompressed byte stream (tar headers, padding and file bodies)
 * that one read pass over an extension archive may produce. Bounds gzip
 * bombs. Matches the registry scoring analyzer's `MAX_EXTRACTED_BYTES`.
 */
export const MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES = 500 * MIB;

/**
 * Renders an archive size or limit in MiB for error messages. Rounds up, so
 * a size just over a limit never prints as equal to it.
 */
export function formatArchiveBytes(bytes: number): string {
  const mib = bytes / MIB;
  return `${
    Number.isInteger(mib) ? mib : (Math.ceil(mib * 10) / 10).toFixed(1)
  } MiB`;
}
