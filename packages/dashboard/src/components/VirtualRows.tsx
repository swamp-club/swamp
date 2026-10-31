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

/**
 * A scrolling list that renders only the rows in view, plus a few either
 * side. Rows have one fixed height, so the window is pure arithmetic. The
 * agent sessions page uses it for turns with hundreds of calls
 * (swamp-club#4155).
 */

import { type ReactNode, useState } from "react";

/** Rows rendered beyond each edge of the view, so a fast scroll stays drawn. */
export const OVERSCAN_ROWS = 8;

/** The rows to render, `[first, end)`, for a scroll position. */
export function visibleWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = OVERSCAN_ROWS,
): { first: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { first: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(
    count,
    Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight) + overscan,
  );
  return { first: Math.min(first, end), end };
}

export interface VirtualRowsProps {
  readonly count: number;
  readonly rowHeight: number;
  /** The visible height; the list scrolls inside it. */
  readonly height: number;
  readonly renderRow: (index: number) => ReactNode;
  readonly label: string;
}

export function VirtualRows(
  { count, rowHeight, height, renderRow, label }: VirtualRowsProps,
) {
  const [scrollTop, setScrollTop] = useState(0);
  const { first, end } = visibleWindow(scrollTop, height, rowHeight, count);
  const rows: ReactNode[] = [];
  for (let i = first; i < end; i++) {
    rows.push(
      <div
        key={i}
        role="listitem"
        style={{
          position: "absolute",
          top: i * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
        }}
      >
        {renderRow(i)}
      </div>,
    );
  }
  return (
    <div
      role="list"
      aria-label={label}
      aria-rowcount={count}
      style={{ height, overflowY: "auto", position: "relative" }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: count * rowHeight, position: "relative" }}>
        {rows}
      </div>
    </div>
  );
}
