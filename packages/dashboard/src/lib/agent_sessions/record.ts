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
 * The dashboard's one door into core: the agent session record that core
 * owns (swamp-club#4154, v2 from #4178). The page imports these names from
 * here, never from `src/` directly; `dashboard_core_import_rules_test.ts`
 * pins that. The module has no Deno or Node APIs, so it bundles as is.
 */

export {
  AGENT_SESSION_LIST_SELECT,
  AGENT_SESSION_TOP_LEVEL_PREDICATE,
  agentSessionChildrenPredicate,
  agentSessionDataName,
  readAgentSessionRecord,
  readAgentSessionSummary,
} from "../../../../../src/domain/agent_sessions/session_record.ts";
export type {
  AgentSessionFinding,
  AgentSessionReading,
  AgentSessionRecord,
  AgentSessionSkipReason,
  AgentSessionSummary,
  AgentSessionToolCall,
  AgentSessionTurn,
} from "../../../../../src/domain/agent_sessions/session_record.ts";
