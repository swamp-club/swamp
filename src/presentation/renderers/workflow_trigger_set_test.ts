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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { renderWorkflowTriggerSet } from "./workflow_trigger_set.ts";

await initializeLogging({});

Deno.test("renderWorkflowTriggerSet: json mode outputs valid JSON", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerSet("json", {
      workflowName: "scan-cves",
      entry: { schedule: "0 3 * * *", inputs: { channel: "#ops" } },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "scan-cves");
  assertEquals(parsed.entry.schedule, "0 3 * * *");
  assertEquals(parsed.entry.inputs.channel, "#ops");
});

Deno.test("renderWorkflowTriggerSet: json mode without inputs", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerSet("json", {
      workflowName: "daily-report",
      entry: { schedule: "0 8 * * 1-5" },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "daily-report");
  assertEquals(parsed.entry.inputs, undefined);
});
