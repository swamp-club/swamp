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
 * Writes the agent session record's and list summary's JSON Schemas for
 * extension authors (swamp-club#4154, swamp-club#4178).
 * session_record_json_schema_test.ts fails when a checked-in file drifts from
 * the Zod schema; run `deno run agent-session-schema` to regenerate them.
 */

import {
  agentSessionRecordJsonSchema,
  agentSessionSummaryJsonSchema,
} from "../src/domain/agent_sessions/session_record.ts";

export const AGENT_SESSION_SCHEMA_PATH =
  "design/surfaces/agent-session-record.schema.json";

export const AGENT_SESSION_SUMMARY_SCHEMA_PATH =
  "design/surfaces/agent-session-summary.schema.json";

if (import.meta.main) {
  await Deno.writeTextFile(
    AGENT_SESSION_SCHEMA_PATH,
    JSON.stringify(agentSessionRecordJsonSchema(), null, 2) + "\n",
  );
  await Deno.writeTextFile(
    AGENT_SESSION_SUMMARY_SCHEMA_PATH,
    JSON.stringify(agentSessionSummaryJsonSchema(), null, 2) + "\n",
  );
}
