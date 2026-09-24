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
 * Returns the extension names that may provide a datastore type, so a
 * command can recognise "pull the datastore extension itself" and name it
 * in remedies.
 *
 * Legacy built-in names are mapped first (`s3` becomes
 * `@swamp/s3-datastore`). The static candidates are the type and its
 * parent prefixes, as the auto-resolver's direct lookup tries them. With a
 * lookup port, the extension the auto-resolver would pick (direct lookup,
 * then search within the collective) is added too, which covers extensions
 * whose name is not a prefix of the type. A lookup failure (offline) falls
 * back to the static candidates.
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
      if (found && !candidates.includes(found)) candidates.push(found);
    } catch {
      // Offline or registry error: the static candidates still apply.
    }
  }
  return candidates;
}
