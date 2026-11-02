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

import { agentMark } from "./agent_badge.ts";

/**
 * A small square before an agent's name: its initials in its colour.
 * Decorative; the name stays as text.
 */
export function AgentBadge(
  { id, size = "sm" }: { id: string; size?: "sm" | "md" | "lg" },
) {
  const mark = agentMark(id);
  return (
    <span
      className={`start-agent-badge start-agent-badge-${size}`}
      style={{ backgroundColor: mark.color }}
      aria-hidden="true"
    >
      {mark.initials}
    </span>
  );
}
