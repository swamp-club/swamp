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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type { CompletionItem } from "../../../domain/data/autocomplete_provider.ts";

const MAX_VISIBLE = 8;

export interface AutocompleteDropdownProps {
  items: CompletionItem[];
  selectedIndex: number;
  /** Column offset to position the dropdown relative to the cursor. */
  offsetLeft: number;
}

/**
 * Renders a dropdown list of autocomplete suggestions.
 */
export function AutocompleteDropdown(
  props: AutocompleteDropdownProps,
): React.ReactElement | null {
  const { items, selectedIndex, offsetLeft } = props;
  if (items.length === 0) return null;

  const visibleStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE / 2),
      items.length - MAX_VISIBLE,
    ),
  );
  const visibleItems = items.slice(visibleStart, visibleStart + MAX_VISIBLE);

  // Find max label width for alignment
  const maxLabelWidth = Math.max(...visibleItems.map((i) => i.label.length));
  const boxWidth = Math.max(
    maxLabelWidth + 2 + (visibleItems.some((i) => i.detail) ? 16 : 0),
    20,
  );

  return (
    <Box flexDirection="column" marginLeft={offsetLeft}>
      {visibleItems.map((item, i) => {
        const isSelected = visibleStart + i === selectedIndex;
        const label = item.label.padEnd(maxLabelWidth);
        return (
          <Box key={visibleStart + i} width={boxWidth}>
            <Text inverse={isSelected}>
              {` ${label}`}
            </Text>
            {item.detail
              ? (
                <Text dimColor={!isSelected} inverse={isSelected}>
                  {` ${item.detail}`}
                </Text>
              )
              : null}
          </Box>
        );
      })}
    </Box>
  );
}
