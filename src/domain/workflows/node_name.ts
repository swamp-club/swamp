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
 * What a step or job name may hold: any printable character, with space as
 * the only whitespace. Control characters (C0 including tab and newline, DEL,
 * C1) are refused because names are printed in command hints and status lines
 * (swamp-club#3027). Nothing else about a name is constrained; swamp-club#3060
 * discusses a stricter rule.
 */
export const NODE_NAME_PATTERN = new RegExp(`^[^${CONTROL_CHARACTER_CLASS}]+$`);

/**
 * The Zod schema for a step or job name. `kind` names the node in the
 * message, and the pattern is published in the workflow JSON schema.
 */
export function nodeName(kind: "Step" | "Job"): z.ZodString {
  return z.string().min(1).regex(NODE_NAME_PATTERN, {
    message:
      `${kind} name must not contain control characters, tab or newline; space is the only whitespace allowed`,
  });
}
