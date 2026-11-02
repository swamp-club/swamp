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
 * How an agent is drawn before its name: initials in its own colour. Swamp
 * shows no vendor logos.
 */
export interface AgentMark {
  readonly initials: string;
  readonly color: string;
}

const MARKS: Record<string, AgentMark> = {
  claude: { initials: "C", color: "#D97757" },
  codex: { initials: "Cx", color: "#10A37F" },
  cursor: { initials: "Cu", color: "#6E6E6E" },
  opencode: { initials: "OC", color: "#F5A623" },
  copilot: { initials: "Co", color: "#8957E5" },
  kiro: { initials: "K", color: "#7B61FF" },
  pi: { initials: "Pi", color: "#2F80ED" },
  amp: { initials: "A", color: "#E5484D" },
  antigravity: { initials: "Ag", color: "#4285F4" },
};

const FALLBACK_COLOR = "#5B6472";

/** The badge for an agent: its initials and colour. */
export function agentMark(id: string): AgentMark {
  const known = MARKS[id];
  if (known) return known;
  const letter = id.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? "?";
  return { initials: letter, color: FALLBACK_COLOR };
}
