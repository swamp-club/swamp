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

import { dim, yellow } from "@std/fmt/colors";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { SearchRenderer } from "./search_renderer.ts";

/** The event shape every search stream emits. */
type SearchListEvent =
  | { kind: "resolving" }
  | { kind: "completed" }
  | { kind: "error"; error: SwampError };

type CompletedOf<E extends SearchListEvent> = Extract<E, { kind: "completed" }>;

/**
 * What a search command plugs into the non-interactive list: its own result
 * filter, the text each entry prints as, and the extras its picker shows.
 */
export interface SearchListConfig<E extends SearchListEvent, T> {
  /** Plural noun for the results, as the picker labels them. */
  itemLabel: string;
  /** The results to list — the same items the command's JSON output holds. */
  items: (event: CompletedOf<E>) => T[];
  /** The text one result prints as. */
  renderEntry: (item: T) => string;
  /** A tip printed under the no-results line. */
  emptyHint?: (event: CompletedOf<E>) => string | undefined;
  /** Runs after the list, for lines a listing ends with. */
  afterList?: (event: CompletedOf<E>) => void;
  /** Turns a stream error into the error the command throws. */
  toError: (error: SwampError) => Error;
}

/**
 * Writes search results as a plain list: one entry per result with a blank
 * line between entries, then a count. Nothing reads stdin, so the command
 * ends as soon as the list is written.
 */
export function writeSearchResultList<T>(
  items: T[],
  renderEntry: (item: T) => string,
  itemLabel: string,
  emptyHint?: string,
): void {
  if (items.length === 0) {
    writeOutput(yellow(`No matching ${itemLabel} found`));
    if (emptyHint) writeOutput(dim(emptyHint));
    return;
  }
  writeOutput(items.map(renderEntry).join("\n\n"));
  writeOutput("");
  writeOutput(dim(`${itemLabel}: ${items.length}`));
}

/**
 * A search renderer that prints a plain list instead of the interactive
 * picker. `swamp ... --server` uses it: a remote search never starts the
 * picker (swamp-club#3917).
 */
export function createSearchListRenderer<E extends SearchListEvent, T>(
  config: SearchListConfig<E, T>,
): SearchRenderer<E, T> {
  return {
    selectedItem: () => undefined,
    handlers: () => {
      const handlers = {
        resolving: () => {},
        completed: (e: CompletedOf<E>) => {
          writeSearchResultList(
            config.items(e),
            config.renderEntry,
            config.itemLabel,
            config.emptyHint?.(e),
          );
          config.afterList?.(e);
        },
        error: (e: { error: SwampError }) => {
          throw config.toError(e.error);
        },
      };
      // EventHandlers<E> is a mapped type over a generic E, which TypeScript
      // cannot match an object literal against; the three kinds are E's kinds.
      return handlers as unknown as EventHandlers<E>;
    },
  };
}
