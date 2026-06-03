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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box } from "ink";

export interface PreviewPaneProps<T, D> {
  /** The currently highlighted item. */
  item: T | undefined;
  /** Fetched detail data (undefined until loaded). */
  detail: D | undefined;
  /** Available width for preview content (characters). */
  width: number;
  /** Available height for preview content (lines). */
  height: number;
  /** Scroll offset (lines from top). Defaults to 0. */
  scrollOffset?: number;
  /** Render callback: receives item, optional detail, and dimensions. */
  renderPreview: (
    item: T,
    detail: D | undefined,
    width: number,
    height: number,
  ) => React.ReactElement;
}

/**
 * Preview content area that shows detail about the currently highlighted item.
 * Height-constrained with overflow hidden to prevent layout overflow.
 *
 * The rendering is delegated to the `renderPreview` callback, which is
 * domain-specific. The PreviewPane handles layout constraints.
 */
export function PreviewPane<T, D>(
  props: PreviewPaneProps<T, D>,
): React.ReactElement {
  const { item, detail, width, height, scrollOffset = 0, renderPreview } =
    props;

  if (item === undefined) {
    return <Box width={width} height={height} />;
  }

  // Render content taller than the viewport so scrolling has room.
  // The outer Box clips via overflow="hidden", the inner Box shifts up
  // via negative marginTop.
  const renderHeight = height + scrollOffset;

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      overflow="hidden"
    >
      <Box flexDirection="column" marginTop={-scrollOffset}>
        {renderPreview(item, detail, width, renderHeight)}
      </Box>
    </Box>
  );
}
