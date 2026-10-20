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
  SENTINEL_SOURCE,
} from "./secret_bag_registry.ts";

/** The prefix every sentinel starts with, checked before a full scan. */
const SENTINEL_MARK = "__SWAMP_VSEC_";

/**
 * Where a sentinel of the run sits in a text, and what it stands for. It
 * carries no value: an entry that holds one (a legacy data entry, or one a
 * worker rebuilt from a dispatch) is described by its reference and origin
 * alone.
 */
export interface SecretOccurrence {
  readonly sentinel: string;
  /** The offset of the sentinel in the text it was found in. */
  readonly start: number;
  /** The offset just past the sentinel. */
  readonly end: number;
  /**
   * The vault name and key the secret stands for. Absent on an entry a
   * worker rebuilt from a dispatch, which carries no reference until
   * typed-secrets Phase 5.
   */
  readonly reference?: SecretReference;
  /** True when the secret reached the run through a data read. */
  readonly dataOrigin: boolean;
  /** Where the reference was written or read from, when the entry records it. */
  readonly location?: string;
}

/**
 * What a destination policy may know about a sentinel: where the secret came
 * from, and its place in the run's issue order.
 */
export interface SecretOrigin {
  readonly dataOrigin: boolean;
  /** The sentinel's position in the run's issue order. */
  readonly sequence: number;
}

/** The origin of a sentinel the run issued; undefined for any other text. */
export type SecretOriginLookup = (sentinel: string) => SecretOrigin | undefined;

/**
 * A value-free view of a run's registry for destination policies
 * (design/enablers/typed-secrets.md Sections 6.3 and 7): what a text holds
 * and where each secret came from, never what it is. A method hook or a
 * policy receives this view instead of a bag, so nothing an entry holds can
 * leave the registry before the load. Sentinel-shaped text the run did not
 * issue, including text with another prefix, is ordinary text and yields no
 * occurrence.
 */
export interface SecretOccurrences {
  /** Every sentinel of the run in `text`, in order of position. */
  occurrencesIn(text: string): readonly SecretOccurrence[];
  /** The origin of a sentinel the run issued. */
  readonly originOf: SecretOriginLookup;
}

/** The view of `registry` that {@link SecretOccurrences} describes. */
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
