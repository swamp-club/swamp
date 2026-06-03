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

import type { ExtensionAutoResolver } from "./extension_auto_resolver.ts";

/**
 * Module-level holder for the auto-resolver instance.
 * Set during CLI startup, accessed by domain services and command handlers.
 */
let resolver: ExtensionAutoResolver | null = null;

/**
 * Sets the auto-resolver instance for the current CLI session.
 */
export function setAutoResolver(
  instance: ExtensionAutoResolver | null,
): void {
  resolver = instance;
}

/**
 * Gets the current auto-resolver instance, or null if not configured.
 */
export function getAutoResolver(): ExtensionAutoResolver | null {
  return resolver;
}
