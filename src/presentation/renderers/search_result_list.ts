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

type SearchListEvent =
  | { kind: "resolving" }
  | { kind: "completed" }
  | { kind: "error"; error: SwampError };

type CompletedOf<E extends SearchListEvent> = Extract<E, { kind: "completed" }>;

export interface SearchListConfig<E extends SearchListEvent, T> {
  itemLabel: string;
  items: (event: CompletedOf<E>) => T[];
  renderEntry: (item: T) => string;
  emptyHint?: (event: CompletedOf<E>) => string | undefined;
  afterList?: (event: CompletedOf<E>) => void;
  toError: (error: SwampError) => Error;
}

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
 * a plain-list search renderer for `--server`, since a remote search never
 * starts the picker
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
