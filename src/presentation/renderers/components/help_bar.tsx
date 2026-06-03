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
import { Text } from "ink";

/**
 * A domain-specific action key binding shown in the help bar.
 */
export interface ActionDef {
  /** Single character key (e.g., "i"). */
  key: string;
  /** Display label (e.g., "Install"). */
  label: string;
  /** Action identifier returned to the caller on activation. */
  action: string;
}

export interface HelpBarProps {
  /** Whether the preview pane is visible (controls whether scroll hint is shown). */
  hasPreview: boolean;
  /** Optional domain-specific action keys. */
  actions?: ActionDef[];
}

/**
 * Keybinding hint bar for the SearchPicker. Shows navigation, preview scroll,
 * action keys, and select/cancel hints. Reusable for any interactive Ink component.
 */
export function HelpBar(props: HelpBarProps): React.ReactElement {
  const { hasPreview, actions } = props;

  const parts: string[] = [
    "\u2191/\u2193 navigate",
  ];

  if (hasPreview) {
    parts.push("Ctrl-u/d scroll preview");
  }

  if (actions && actions.length > 0) {
    for (const action of actions) {
      parts.push(`${action.key} ${action.label.toLowerCase()}`);
    }
  }

  parts.push("Enter select");
  parts.push("Esc cancel");

  return <Text dimColor>{parts.join("  ")}</Text>;
}
