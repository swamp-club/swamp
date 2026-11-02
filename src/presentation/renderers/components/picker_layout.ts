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

export type PickerTier = "bordered-split" | "stacked" | "inline" | "minimal";

export interface PickerLayout {
  readonly tier: PickerTier;
  readonly resultsWidth: number;
  readonly previewWidth: number;
  readonly resultsHeight: number;
  readonly previewHeight: number;
}

const BORDERED_CHROME_LINES = 6;

const STACKED_DIVIDER_LINES = 1;

const INLINE_CHROME_LINES = 3;

const INLINE_PREVIEW_LINES = 4;

const MIN_RESULTS_HEIGHT = 3;

const MIN_PREVIEW_HEIGHT = 3;

const RESULTS_WIDTH_FRACTION = 0.4;

const MAX_RESULTS_WIDTH = 50;

const MIN_RESULTS_WIDTH = 20;

const MIN_PREVIEW_WIDTH = 30;

const SPLIT_BORDER_COLS = 3;

const STACKED_BORDER_COLS = 2;

const STACKED_RESULTS_FRACTION = 0.45;

export function computePickerLayout(
  width: number,
  height: number,
): PickerLayout {
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
      previewWidth: width - 4,
      resultsHeight,
      previewHeight: Math.max(0, previewHeight),
    };
  }

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
