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

import type { WithheldAsset } from "../domain/remote/protocol.ts";

/**
 * fingerprints are content hashes, so entries never change once registered and
 * a worker caches them forever
 */

export interface RegisteredBundle {
  js: string;
  filesRoot?: string;
  /**
   * only these files and binaries are served to workers; with both empty or
   * undefined no co-located assets ship
   */
  additionalFiles?: string[];
  /** served like additionalFiles, and written executable by the worker */
  binaries?: string[];
  /** listed to the worker so its extensionFile() can say why one is absent */
  withheld?: readonly WithheldAsset[];
  /**
   * content hash of each asset when the fingerprint was computed; the data
   * plane serves only bytes that still match, so a fingerprint never names
   * other assets
   */
  assetHashes?: ReadonlyMap<string, string>;
}

export async function hashAssetBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export class BundleRegistry {
  readonly #byFingerprint = new Map<string, RegisteredBundle>();

  register(fingerprint: string, bundle: RegisteredBundle): void {
    if (!this.#byFingerprint.has(fingerprint)) {
      this.#byFingerprint.set(fingerprint, bundle);
    }
  }

  get(fingerprint: string): RegisteredBundle | null {
    return this.#byFingerprint.get(fingerprint) ?? null;
  }
}
