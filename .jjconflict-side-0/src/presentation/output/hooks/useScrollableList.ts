import { useEffect, useState } from "react";

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
  const [scrollOffset, setScrollOffset] = useState(0);

  // Adjust scroll offset to keep selected item visible
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + maxVisible) {
      setScrollOffset(selectedIndex - maxVisible + 1);
    }
  }, [selectedIndex, scrollOffset, maxVisible]);

  // Reset selection and scroll when dependencies change (e.g., query)
  useEffect(() => {
    setSelectedIndex(0);
    setScrollOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, resetDeps);

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxVisible);

  const scrollMetrics: ScrollMetrics = {
    hasMoreAbove: scrollOffset > 0,
    hasMoreBelow: scrollOffset + maxVisible < items.length,
    moreAboveCount: scrollOffset,
    moreBelowCount: Math.max(0, items.length - scrollOffset - maxVisible),
  };

  return {
    selectedIndex,
    setSelectedIndex,
    scrollOffset,
    visibleItems,
    scrollMetrics,
  };
}
