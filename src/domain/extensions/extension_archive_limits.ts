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
 * matches the scoring analyzer's MAX_TARBALL_BYTES, the registry's only
 * ceiling, so every archive it can score still installs
 */
export const MAX_EXTENSION_ARCHIVE_BYTES = 50 * MIB;

/**
 * bounds gzip bombs; matches the registry scoring analyzer's
 * MAX_EXTRACTED_BYTES
 */
export const MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES = 500 * MIB;

/** rounds up so a size just over a limit never prints as equal to it */
export function formatArchiveBytes(bytes: number): string {
  const mib = bytes / MIB;
  return `${
    Number.isInteger(mib) ? mib : (Math.ceil(mib * 10) / 10).toFixed(1)
  } MiB`;
}
