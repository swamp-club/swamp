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
 * Registry of dispatchable extension bundles, keyed by content fingerprint.
 *
 * The dispatcher registers a bundle (and the filesystem root its co-located
 * assets resolve from) when it ships a fingerprint in a dispatch; the data
 * plane serves `GET /bundle/{fingerprint}` and
 * `GET /bundle/{fingerprint}/file/{relPath}` from here. Fingerprints are
 * content hashes, so entries never change once registered — a worker caches
 * them forever (see design/remote-execution.md, "Shipping extension code").
 */

export interface RegisteredBundle {
  /** The self-contained bundle source (a single JS module). */
  js: string;
  /**
   * Absolute root for co-located asset resolution (`extensionFilesRoot`).
   * Undefined for built-in models, which carry no assets.
   */
  filesRoot?: string;
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
