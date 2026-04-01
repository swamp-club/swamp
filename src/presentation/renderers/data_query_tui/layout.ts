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
 * Layout metrics for the data query TUI.
 */
export interface QueryTuiLayout {
  /** Height available for the results table (rows). */
  resultsHeight: number;
  /** Height available for the inspector overlay. */
  inspectorHeight: number;
  /** Width available for the inspector overlay. */
  inspectorWidth: number;
}

/**
 * Fixed vertical chrome:
 *   brand(1) + QUERY input(1) + SELECT input(1) + LIMIT input(1)
 *   + separator(1) + separator(1) + help bar(1) = 7 lines
 */
const CHROME_LINES = 7;

/**
 * Computes layout metrics from terminal dimensions.
 *
 * @param autocompleteLines - Number of visible autocomplete dropdown lines (0 when closed)
 * @param errorLines - Number of error text lines (0 when no error)
 */
export function computeQueryTuiLayout(
  width: number,
  height: number,
  autocompleteLines: number,
  errorLines: number,
): QueryTuiLayout {
  const resultsHeight = Math.max(
    1,
    height - CHROME_LINES - autocompleteLines - errorLines,
  );
  const inspectorHeight = resultsHeight;
  const inspectorWidth = Math.min(width - 4, 80);

  return {
    resultsHeight,
    inspectorHeight,
    inspectorWidth,
  };
}
