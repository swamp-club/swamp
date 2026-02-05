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
