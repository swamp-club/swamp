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

export interface QueryTuiLayout {
  resultsHeight: number;
  inspectorHeight: number;
  inspectorWidth: number;
}

const CHROME_LINES = 7;

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
