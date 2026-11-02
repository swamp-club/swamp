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

import { useRef, useState } from "react";

export function calculateScrollWindow(
  totalItems: number,
  selectedIndex: number,
  visibleHeight: number,
): { start: number; end: number } {
  if (totalItems === 0 || visibleHeight <= 0) {
    return { start: 0, end: 0 };
  }

  const maxStart = Math.max(0, totalItems - visibleHeight);
  let start = 0;

  if (selectedIndex >= start + visibleHeight) {
    start = selectedIndex - visibleHeight + 1;
  }

  if (selectedIndex < start) {
    start = selectedIndex;
  }

  start = Math.min(Math.max(0, start), maxStart);
  const end = Math.min(start + visibleHeight, totalItems);

  return { start, end };
}

export interface ScrollMetrics {
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
  moreAboveCount: number;
  moreBelowCount: number;
}

export interface UseScrollableListResult<T> {
  selectedIndex: number;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  scrollOffset: number;
  visibleItems: T[];
  scrollMetrics: ScrollMetrics;
}

export function useScrollableList<T>(
  items: T[],
  maxVisible: number = 10,
  resetDeps: unknown[] = [],
  initialIndex: number = 0,
): UseScrollableListResult<T> {
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, Math.min(initialIndex, items.length - 1))
  );
  // ref keeps scrolling sticky: the viewport moves only when the selected item
  // would leave it
  const scrollOffsetRef = useRef(0);
  const [prevResetDeps, setPrevResetDeps] = useState(resetDeps);

  // reset during render, not in an effect, so no frame draws the new
  // dependencies with the old selection; the first render keeps the initial
  // index
  if (
    resetDeps.length !== prevResetDeps.length ||
    resetDeps.some((dep, i) => !Object.is(dep, prevResetDeps[i]))
  ) {
    setPrevResetDeps(resetDeps);
    setSelectedIndex(0);
    scrollOffsetRef.current = 0;
  }

  let effectiveScrollOffset = scrollOffsetRef.current;

  if (selectedIndex < effectiveScrollOffset) {
    effectiveScrollOffset = selectedIndex;
  } else if (selectedIndex >= effectiveScrollOffset + maxVisible) {
    effectiveScrollOffset = selectedIndex - maxVisible + 1;
  }

  const maxScrollOffset = Math.max(0, items.length - maxVisible);
  effectiveScrollOffset = Math.min(effectiveScrollOffset, maxScrollOffset);
  effectiveScrollOffset = Math.max(0, effectiveScrollOffset);

  scrollOffsetRef.current = effectiveScrollOffset;

  const visibleItems = items.slice(
    effectiveScrollOffset,
    effectiveScrollOffset + maxVisible,
  );

  const scrollMetrics: ScrollMetrics = {
    hasMoreAbove: effectiveScrollOffset > 0,
    hasMoreBelow: effectiveScrollOffset + maxVisible < items.length,
    moreAboveCount: effectiveScrollOffset,
    moreBelowCount: Math.max(
      0,
      items.length - effectiveScrollOffset - maxVisible,
    ),
  };

  return {
    selectedIndex,
    setSelectedIndex,
    scrollOffset: effectiveScrollOffset,
    visibleItems,
    scrollMetrics,
  };
}
