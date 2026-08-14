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
import { renderWorkflowTriggerRemove } from "./workflow_trigger_remove.ts";

await initializeLogging({});

Deno.test("renderWorkflowTriggerRemove: json mode outputs workflow name", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerRemove("json", { workflowName: "scan-cves" });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "scan-cves");
});
