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
  isIssuedEntry,
  type SecretBagRegistry,
  type SecretReference,
  SENTINEL_MARK,
  SENTINEL_SOURCE,
} from "./secret_bag_registry.ts";

export interface SecretOccurrence {
  readonly sentinel: string;
  readonly start: number;
  readonly end: number;
  readonly reference?: SecretReference;
  readonly dataOrigin: boolean;
  readonly location?: string;
}

export interface SecretOrigin {
  readonly dataOrigin: boolean;
  readonly sequence: number;
}

export type SecretOriginLookup = (sentinel: string) => SecretOrigin | undefined;

/**
 * value-free view: a hook or policy gets this instead of a bag so nothing an
 * entry holds can leave before the load; sentinel-shaped text the run did not
 * issue is ordinary text
 */
export interface SecretOccurrences {
  occurrencesIn(text: string): readonly SecretOccurrence[];
  readonly originOf: SecretOriginLookup;
}

export function secretOccurrencesOf(
  registry: SecretBagRegistry,
): SecretOccurrences {
  const pattern = new RegExp(SENTINEL_SOURCE, "g");
  return {
    occurrencesIn(text) {
      if (!text.includes(SENTINEL_MARK)) return [];
      const found: SecretOccurrence[] = [];
      for (const match of text.matchAll(pattern)) {
        const entry = registry.entryOf(match[0]);
        if (entry === undefined) continue;
        const start = match.index ?? 0;
        const issued = isIssuedEntry(entry) ? entry : undefined;
        found.push({
          sentinel: match[0],
          start,
          end: start + match[0].length,
          ...(issued ? { reference: issued.reference } : {}),
          dataOrigin: entry.dataOrigin,
          ...(issued && "location" in issued
            ? { location: issued.location }
            : {}),
        });
      }
      return found;
    },
    originOf: (sentinel) => {
      const entry = registry.entryOf(sentinel);
      if (entry === undefined) return undefined;
      return {
        dataOrigin: entry.dataOrigin,
        sequence: registry.sequenceOf(sentinel)!,
      };
    },
  };
}
