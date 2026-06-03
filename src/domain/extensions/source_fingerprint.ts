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
 * Stable identifier of a source file's contents for catalog freshness.
 *
 * Two shapes:
 *   - `<sha-256-hex>` — successful fingerprint over the entry point and
 *     its transitive local imports. Equality means "the same content
 *     graph, byte-for-byte."
 *   - `MISSING:<sha-256-hex>` — the entry point or one of its imports
 *     could not be read at fingerprint time. The hash is over a stable
 *     descriptor of which dep was unreadable, so two consecutive runs
 *     with the same broken state produce the same value (no rebundle
 *     loop). The `MISSING:` prefix is the only signal that the
 *     fingerprint is in the "broken-but-stable" branch.
 *
 * Treated as a value type by the domain — the catalog stores it as TEXT,
 * the aggregate compares it via string equality, and consumers must not
 * try to parse the hex portion. The format is opaque to everything except
 * the fingerprint producer.
 */
export type SourceFingerprint = string;
