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

import {
  extensionCandidateNames,
  type ExtensionLookupPort,
  findExtensionForType,
  typeCollective,
} from "../extensions/extension_auto_resolver.ts";
import { RENAMED_DATASTORE_TYPES } from "./renamed_datastore_types.ts";

/**
 * legacy built-in names map first; with a lookup port the extension the
 * auto-resolver would pick is added, covering names that are not a prefix of
 * the type; a lookup failure falls back to the static candidates
 */
export async function datastoreExtensionCandidates(
  datastoreType: string,
  extensionLookup?: ExtensionLookupPort,
): Promise<string[]> {
  const type = RENAMED_DATASTORE_TYPES[datastoreType] ?? datastoreType;
  if (!type.startsWith("@")) return [];

  const candidates = extensionCandidateNames(type);
  const collective = typeCollective(type);
  if (extensionLookup && collective) {
    try {
      const found = await findExtensionForType(
        type,
        collective,
        extensionLookup,
      );
      if (found && !candidates.includes(found.name)) {
        candidates.push(found.name);
      }
    } catch {
      // Offline or registry error: the static candidates still apply.
    }
  }
  return candidates;
}
