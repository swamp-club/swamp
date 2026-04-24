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

import { UserError } from "../domain/errors.ts";
import type { AiTool } from "../infrastructure/persistence/repo_marker_repository.ts";

/** The canonical list of valid AI tool names. */
export const VALID_AI_TOOLS: readonly AiTool[] = [
  "claude",
  "cursor",
  "kiro",
  "opencode",
  "codex",
  "copilot",
  "none",
] as const;

/**
 * Parses a raw `--tool` flag value against the AiTool union. Throws a
 * UserError listing valid values when the raw value is not a match.
 *
 * Centralised here so every CLI command that accepts `--tool <name>`
 * validates the same way.
 */
export function parseAiToolOrThrow(raw: string): AiTool {
  if (VALID_AI_TOOLS.includes(raw as AiTool)) {
    return raw as AiTool;
  }
  throw new UserError(
    `Invalid --tool value: \`${raw}\`. Valid values are: ${
      VALID_AI_TOOLS.join(", ")
    }.`,
  );
}
