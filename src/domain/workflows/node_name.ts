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

import { z } from "zod";
import { CONTROL_CHARACTER_CLASS } from "../control_characters.ts";

/**
 * any printable character, with space the only whitespace; control characters
 * are refused because names are printed in command hints and status lines
 */
export const NODE_NAME_PATTERN = new RegExp(`^[^${CONTROL_CHARACTER_CLASS}]+$`);

export function nodeName(kind: "Step" | "Job"): z.ZodString {
  return z.string().min(1).regex(NODE_NAME_PATTERN, {
    message:
      `${kind} name must not contain control characters, tab or newline; space is the only whitespace allowed`,
  });
}
