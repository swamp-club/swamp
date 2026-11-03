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

/**
 * a host-wide store of verified extension archives, addressed by their SHA-256
 * so a hit is the exact bytes the registry's checksum names; installs treat a
 * throw as a miss or a skipped write
 */
export interface ExtensionArchiveCache {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, archive: Uint8Array): Promise<void>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** the key becomes a file name, so anything but 64 hex characters is refused */
export function archiveCacheKey(checksum: string | null): string | null {
  if (checksum === null) return null;
  const key = checksum.toLowerCase();
  return SHA256_HEX.test(key) ? key : null;
}
