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

import { useCallback, useEffect, useState } from "react";

/**
 * Return value from usePreviewScroll.
 */
export interface PreviewScrollResult {
  /** Current scroll offset (lines from top). */
  scrollOffset: number;
  /** Scroll up by half a page. */
  scrollUp: () => void;
  /** Scroll down by half a page. */
  scrollDown: () => void;
}

/**
 * React hook for managing scroll position within a preview pane.
 *
 * Provides half-page scrolling (Ctrl-u / Ctrl-d) and automatically resets
 * to the top when the content identity changes (tracked via `resetKey`).
 *
 * @param contentHeight - Total number of lines in the preview content.
 * @param viewportHeight - Number of lines visible in the preview pane.
 * @param resetKey - When this value changes, scroll resets to 0. Typically
 *   tied to the selected item identity.
 */
export function usePreviewScroll(
  contentHeight: number,
  viewportHeight: number,
  resetKey: unknown,
): PreviewScrollResult {
  const [scrollOffset, setScrollOffset] = useState(0);

  // Reset to top when the selected item changes
  useEffect(() => {
    setScrollOffset(0);
  }, [resetKey]);

  const maxOffset = Math.max(0, contentHeight - viewportHeight);
  const halfPage = Math.max(1, Math.floor(viewportHeight / 2));

  const scrollUp = useCallback(() => {
    setScrollOffset((prev) => Math.max(0, prev - halfPage));
  }, [halfPage]);

  const scrollDown = useCallback(() => {
    setScrollOffset((prev) => Math.min(maxOffset, prev + halfPage));
  }, [halfPage, maxOffset]);

  // Clamp current offset if content shrinks
  const clampedOffset = Math.min(scrollOffset, maxOffset);

  return {
    scrollOffset: clampedOffset,
    scrollUp,
    scrollDown,
  };
}
