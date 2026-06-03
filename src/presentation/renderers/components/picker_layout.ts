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
 * Degradation tiers for the SearchPicker, from richest to most compact.
 *
 * - bordered-split: Side-by-side results + preview with box-drawing borders
 * - stacked: Results above, preview below, both bordered
 * - inline: Full-width results list with inline detail expansion below selected item
 * - minimal: Falls back to existing SearchTUI behavior
 */
export type PickerTier = "bordered-split" | "stacked" | "inline" | "minimal";

/**
 * Computed layout dimensions for the SearchPicker. Value object — immutable,
 * deterministic from terminal dimensions.
 */
export interface PickerLayout {
  readonly tier: PickerTier;
  /** Width available for the results list (characters). */
  readonly resultsWidth: number;
  /** Width available for the preview pane (characters). */
  readonly previewWidth: number;
  /** Number of visible result items (rows). */
  readonly resultsHeight: number;
  /** Number of lines available for preview content. */
  readonly previewHeight: number;
}

/**
 * Chrome overhead in the bordered-split and stacked tiers:
 * - Search bar border top (1) + search row (1) + border mid (1) = 3
 * - Help bar border (1) + help row (1) + border bottom (1) = 3
 * Total chrome = 6 lines
 */
const BORDERED_CHROME_LINES = 6;

/**
 * Chrome overhead in the stacked tier includes an extra border row between
 * the results and preview panes.
 */
const STACKED_DIVIDER_LINES = 1;

/**
 * Chrome overhead in the inline tier (no borders):
 * - Search bar (1) + count line (1) + help line (1) = 3
 */
const INLINE_CHROME_LINES = 3;

/** Lines reserved for inline preview expansion below the selected item. */
const INLINE_PREVIEW_LINES = 4;

/** Minimum results visible in any tier (below this, degrade further). */
const MIN_RESULTS_HEIGHT = 3;

/** Minimum preview height worth showing. */
const MIN_PREVIEW_HEIGHT = 3;

/**
 * Fraction of available width allocated to the results pane in bordered-split.
 * The remainder goes to preview.
 */
const RESULTS_WIDTH_FRACTION = 0.4;

/** Maximum width for the results pane (characters). */
const MAX_RESULTS_WIDTH = 50;

/** Minimum width for the results pane to be useful. */
const MIN_RESULTS_WIDTH = 20;

/** Minimum width for the preview pane to be useful. */
const MIN_PREVIEW_WIDTH = 30;

/**
 * In bordered-split, 1 column is used for the vertical divider between
 * results and preview, plus 2 columns for the left/right outer borders.
 */
const SPLIT_BORDER_COLS = 3;

/**
 * In stacked mode, 2 columns for left/right outer borders.
 */
const STACKED_BORDER_COLS = 2;

/**
 * Fraction of available height allocated to results in stacked mode.
 */
const STACKED_RESULTS_FRACTION = 0.45;

/**
 * Computes the appropriate layout tier and dimensions given terminal size.
 * Pure function — no side effects, fully deterministic.
 *
 * Follows the same pattern as workflow_run_tree/budget.ts: check from
 * richest tier to most compact, returning the first that fits.
 */
export function computePickerLayout(
  width: number,
  height: number,
): PickerLayout {
  // Try bordered-split: side-by-side with borders
  if (width >= 90 && height >= 16) {
    const innerWidth = width - SPLIT_BORDER_COLS;
    const resultsWidth = Math.min(
      MAX_RESULTS_WIDTH,
      Math.max(
        MIN_RESULTS_WIDTH,
        Math.floor(innerWidth * RESULTS_WIDTH_FRACTION),
      ),
    );
    const previewWidth = innerWidth - resultsWidth;

    if (previewWidth >= MIN_PREVIEW_WIDTH) {
      const contentHeight = height - BORDERED_CHROME_LINES;
      const resultsHeight = Math.max(MIN_RESULTS_HEIGHT, contentHeight);
      const previewHeight = Math.max(MIN_PREVIEW_HEIGHT, contentHeight);

      return {
        tier: "bordered-split",
        resultsWidth,
        previewWidth,
        resultsHeight,
        previewHeight,
      };
    }
  }

  // Try stacked: results above, preview below, both bordered
  if (width >= 60 && height >= 24) {
    const innerWidth = width - STACKED_BORDER_COLS;
    const contentHeight = height - BORDERED_CHROME_LINES -
      STACKED_DIVIDER_LINES;
    const resultsHeight = Math.max(
      MIN_RESULTS_HEIGHT,
      Math.floor(contentHeight * STACKED_RESULTS_FRACTION),
    );
    const previewHeight = Math.max(
      MIN_PREVIEW_HEIGHT,
      contentHeight - resultsHeight,
    );

    return {
      tier: "stacked",
      resultsWidth: innerWidth,
      previewWidth: innerWidth,
      resultsHeight,
      previewHeight,
    };
  }

  // Try inline: full-width list with inline expansion
  if (width >= 60 && height >= 12) {
    const contentHeight = height - INLINE_CHROME_LINES;
    const resultsHeight = Math.max(
      MIN_RESULTS_HEIGHT,
      contentHeight - INLINE_PREVIEW_LINES,
    );
    const previewHeight = Math.min(
      INLINE_PREVIEW_LINES,
      contentHeight - MIN_RESULTS_HEIGHT,
    );

    return {
      tier: "inline",
      resultsWidth: width,
      previewWidth: width - 4, // indented
      resultsHeight,
      previewHeight: Math.max(0, previewHeight),
    };
  }

  // Minimal: falls back to existing SearchTUI behavior
  const contentHeight = Math.max(
    MIN_RESULTS_HEIGHT,
    height - INLINE_CHROME_LINES,
  );

  return {
    tier: "minimal",
    resultsWidth: width,
    previewWidth: 0,
    resultsHeight: Math.min(10, contentHeight),
    previewHeight: 0,
  };
}
