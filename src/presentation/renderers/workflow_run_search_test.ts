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
import {
  createWorkflowRunSearchRenderer,
  reapedRunsLine,
} from "./workflow_run_search.tsx";

const REAPED = { cutoff: "2026-10-01T00:00:00.000Z", retention: "14d" };

Deno.test("JsonWorkflowRunSearchRenderer: includes reapedBefore when present", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const handlers = createWorkflowRunSearchRenderer("json").handlers();
    handlers.completed({
      kind: "completed",
      data: { query: "", results: [], reapedBefore: REAPED },
      total: 0,
    });
    handlers.completed({
      kind: "completed",
      data: { query: "", results: [] },
      total: 0,
    });
  } finally {
    console.log = originalLog;
  }
  assertEquals(JSON.parse(logs[0]).reapedBefore, REAPED);
  assertEquals("reapedBefore" in JSON.parse(logs[1]), false);
});

Deno.test("reapedRunsLine: names the cutoff and the retention", () => {
  assertEquals(
    reapedRunsLine(REAPED),
    "Older runs reaped by retention before 2026-10-01T00:00:00.000Z (14d)",
  );
});
