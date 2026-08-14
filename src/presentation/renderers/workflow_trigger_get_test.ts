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
import { renderWorkflowTriggerGet } from "./workflow_trigger_get.ts";

await initializeLogging({});

Deno.test("renderWorkflowTriggerGet: json mode outputs complete data", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerGet("json", {
      workflowName: "scan-cves",
      builtIn: { schedule: "0 6 * * *", inputs: {} },
      override: { schedule: "0 3 * * *" },
      effective: { schedule: "0 3 * * *", inputs: {} },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "scan-cves");
  assertEquals(parsed.builtIn.schedule, "0 6 * * *");
  assertEquals(parsed.override.schedule, "0 3 * * *");
  assertEquals(parsed.effective.schedule, "0 3 * * *");
});

Deno.test("renderWorkflowTriggerGet: json mode with no trigger", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerGet("json", {
      workflowName: "nonexistent",
      builtIn: null,
      override: null,
      effective: { schedule: null, inputs: {} },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "nonexistent");
  assertEquals(parsed.builtIn, null);
  assertEquals(parsed.override, null);
});
