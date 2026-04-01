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

export interface CelInputProps {
  /** Label shown before the input (e.g., "QUERY", "SELECT"). */
  label: string;
  /** Current text content. */
  text: string;
  /** Current cursor position (character index). */
  cursorPos: number;
  /** Whether this input is focused. */
  focused: boolean;
  /** Optional status text shown after the input. */
  status?: string;
}

/**
 * Single-line text input with cursor position tracking.
 * The parent component manages state and key handling.
 */
export function CelInput(props: CelInputProps): React.ReactElement {
  const { label, text, cursorPos, focused, status } = props;

  const before = text.slice(0, cursorPos);
  const after = text.slice(cursorPos);

  return (
    <Box>
      <Text color={focused ? "cyan" : undefined} dimColor={!focused} bold>
        {`  ${label.padEnd(7)}`}
      </Text>
      <Text>
        {before}
        {focused ? <Text inverse>{after[0] ?? " "}</Text> : null}
        {focused ? after.slice(1) : after}
        {!focused && !text ? <Text dimColor>(empty)</Text> : null}
      </Text>
      {status
        ? (
          <Text dimColor>
            {`  ${status}`}
          </Text>
        )
        : null}
    </Box>
  );
}

/**
 * Applies a character insertion at the cursor position.
 * Returns the new text and cursor position.
 */
export function insertAtCursor(
  text: string,
  cursorPos: number,
  char: string,
): { text: string; cursorPos: number } {
  return {
    text: text.slice(0, cursorPos) + char + text.slice(cursorPos),
    cursorPos: cursorPos + char.length,
  };
}

/**
 * Applies a backspace at the cursor position.
 * Returns the new text and cursor position.
 */
export function deleteBeforeCursor(
  text: string,
  cursorPos: number,
): { text: string; cursorPos: number } {
  if (cursorPos === 0) return { text, cursorPos };
  return {
    text: text.slice(0, cursorPos - 1) + text.slice(cursorPos),
    cursorPos: cursorPos - 1,
  };
}
