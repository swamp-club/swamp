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

/**
 * Extension-author-facing subset of swamp's VaultProvider.
 *
 * These types mirror the fields that extension vault implementations
 * actually use. A CI test in the main swamp repo verifies structural
 * compatibility with the canonical types.
 */

/**
 * Interface for vault providers that securely store and retrieve secrets.
 *
 * Extension authors implement this interface to create custom vault backends.
 */
export interface VaultProvider {
  /** Retrieves a secret value from the vault. */
  get(secretKey: string): Promise<string>;
  /** Stores a secret value in the vault. */
  put(secretKey: string, secretValue: string): Promise<void>;
  /** Lists all secret keys in the vault (names only, not values). */
  list(): Promise<string[]>;
  /** Gets the name/type of this vault provider. */
  getName(): string;
}
