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

import { useEffect, useRef, useState } from "react";

/**
 * Calculates visible window for a scrollable list.
 * Keeps the selected item visible by auto-scrolling.
 */
export function calculateScrollWindow(
  totalItems: number,
  selectedIndex: number,
  visibleHeight: number,
): { start: number; end: number } {
  if (totalItems === 0 || visibleHeight <= 0) {
    return { start: 0, end: 0 };
  }

  // Calculate the window that keeps selectedIndex visible
  const maxStart = Math.max(0, totalItems - visibleHeight);
  let start = 0;

  // If selected item is below the visible window, scroll down
  if (selectedIndex >= start + visibleHeight) {
    start = selectedIndex - visibleHeight + 1;
  }

  // If selected item is above the visible window, scroll up
  if (selectedIndex < start) {
    start = selectedIndex;
  }

  // Clamp to valid range
  start = Math.min(Math.max(0, start), maxStart);
  const end = Math.min(start + visibleHeight, totalItems);

  return { start, end };
}

/**
 * Scroll metrics for displaying "more above/below" indicators.
 */
export interface ScrollMetrics {
  /** Whether there are items above the visible window */
  hasMoreAbove: boolean;
  /** Whether there are items below the visible window */
  hasMoreBelow: boolean;
  /** Number of items hidden above */
  moreAboveCount: number;
  /** Number of items hidden below */
  moreBelowCount: number;
}

/**
 * Return type for the useScrollableList hook.
 */
export interface UseScrollableListResult<T> {
  /** Currently selected index in the full list */
  selectedIndex: number;
  /** Function to update the selected index */
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Current scroll offset */
  scrollOffset: number;
  /** Items visible in the current window */
  visibleItems: T[];
  /** Scroll metrics for "more above/below" indicators */
  scrollMetrics: ScrollMetrics;
}

/**
 * React hook for managing a scrollable list with selection.
 *
 * This hook handles:
 * - Selected index state
 * - Scroll offset state
 * - Auto-scrolling to keep selected item visible
 * - Resetting selection/scroll when items change
 * - Calculating visible window and scroll metrics
 *
 * @param items - The full list of items
 * @param maxVisible - Maximum number of items visible at once (default: 10)
 * @param resetDeps - Additional dependencies that trigger selection reset
 * @returns Selection state, visible items, and scroll metrics
 *
 * @example
 * ```tsx
 * const { selectedIndex, setSelectedIndex, visibleItems, scrollMetrics } =
 *   useScrollableList(results, 10, [query]);
 *
 * // In render:
 * {scrollMetrics.hasMoreAbove && <Text>... {scrollMetrics.moreAboveCount} more above</Text>}
 * {visibleItems.map((item, index) => (
 *   <Item key={item.id} isSelected={index + scrollMetrics.moreAboveCount === selectedIndex} />
 * ))}
 * {scrollMetrics.hasMoreBelow && <Text>... {scrollMetrics.moreBelowCount} more below</Text>}
 * ```
 */
export function useScrollableList<T>(
  items: T[],
  maxVisible: number = 10,
  resetDeps: unknown[] = [],
): UseScrollableListResult<T> {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Use ref to track scroll offset for "sticky" scrolling behavior
  // (viewport only moves when selected item would go off-screen)
  const scrollOffsetRef = useRef(0);

  // Reset selection and scroll when dependencies change (e.g., query)
  useEffect(() => {
    setSelectedIndex(0);
    scrollOffsetRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps);

  // Compute effective scroll offset synchronously during render
  // This ensures the selected item is always visible without render lag
  let effectiveScrollOffset = scrollOffsetRef.current;

  // If selected item is above the visible window, scroll up
  if (selectedIndex < effectiveScrollOffset) {
    effectiveScrollOffset = selectedIndex;
  } // If selected item is below the visible window, scroll down
  else if (selectedIndex >= effectiveScrollOffset + maxVisible) {
    effectiveScrollOffset = selectedIndex - maxVisible + 1;
  }

  // Clamp scroll offset to valid bounds (handles case where items array shrinks)
  const maxScrollOffset = Math.max(0, items.length - maxVisible);
  effectiveScrollOffset = Math.min(effectiveScrollOffset, maxScrollOffset);
  effectiveScrollOffset = Math.max(0, effectiveScrollOffset);

  // Update ref for next render's "sticky" behavior
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
