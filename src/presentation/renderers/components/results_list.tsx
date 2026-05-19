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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type { ScrollMetrics } from "./hooks/mod.ts";

const INDENT = "  ";

export interface ResultsListProps<T> {
  /** Visible items in the current scroll window. */
  visibleItems: T[];
  /** Index of the selected item in the full list (not the visible window). */
  selectedIndex: number;
  /** Scroll metrics for "more above/below" indicators. */
  scrollMetrics: ScrollMetrics;
  /** Render callback for a single result line. */
  renderLine: (item: T) => React.ReactElement;
  /** Maximum width for each result line (characters). */
  width: number;
}

/**
 * Scrollable single-column result list with reverse-video selection and
 * "... N more above/below" indicators.
 *
 * Reusable for any selection list — not coupled to search.
 */
export function ResultsList<T>(
  props: ResultsListProps<T>,
): React.ReactElement {
  const { visibleItems, selectedIndex, scrollMetrics, renderLine, width } =
    props;

  return (
    <Box flexDirection="column" width={width} overflow="hidden">
      {scrollMetrics.hasMoreAbove && (
        <Text dimColor>
          {INDENT}... {scrollMetrics.moreAboveCount} more above
        </Text>
      )}
      {visibleItems.map((item, index) => {
        const isSelected =
          index + scrollMetrics.moreAboveCount === selectedIndex;
        return (
          <Box key={index} width={width} overflow="hidden">
            {isSelected
              ? (
                <Text inverse bold wrap="truncate-end">
                  {" "}
                  <ResultLineWrapper renderLine={renderLine} item={item} />
                  {" "}
                </Text>
              )
              : (
                <Text wrap="truncate-end">
                  {INDENT}
                  <ResultLineWrapper renderLine={renderLine} item={item} />
                </Text>
              )}
          </Box>
        );
      })}
      {scrollMetrics.hasMoreBelow && (
        <Text dimColor>
          {INDENT}... {scrollMetrics.moreBelowCount} more below
        </Text>
      )}
    </Box>
  );
}

/**
 * Wrapper to call the generic renderLine callback. This exists as a separate
 * component so that the generic `T` flows through correctly.
 */
function ResultLineWrapper<T>(
  props: { renderLine: (item: T) => React.ReactElement; item: T },
): React.ReactElement {
  return props.renderLine(props.item);
}
