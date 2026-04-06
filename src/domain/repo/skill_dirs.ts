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

/**
 * Maps AI tool names to their skill directory paths (relative to repo root).
 */
export const SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
  kiro: ".kiro/skills",
};

/**
 * Maps AI tool names to the global (user-level) skill directory path segment.
 * Used as a fallback when resolving skills for push.
 */
export const GLOBAL_SKILL_DIRS: Record<string, string> = {
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
  kiro: ".kiro/skills",
};
