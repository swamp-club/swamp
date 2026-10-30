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

import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { agentSessionRecordJsonSchema } from "./session_record.ts";

const CHECKED_IN = fromFileUrl(
  new URL(
    "../../../design/surfaces/agent-session-record.schema.json",
    import.meta.url,
  ),
);

Deno.test("agentSessionRecordJsonSchema: matches the checked-in schema for extension authors", async () => {
  const checkedIn = JSON.parse(await Deno.readTextFile(CHECKED_IN));
  assertEquals(
    checkedIn,
    agentSessionRecordJsonSchema(),
    "design/surfaces/agent-session-record.schema.json is stale; run `deno run agent-session-schema`",
  );
});
