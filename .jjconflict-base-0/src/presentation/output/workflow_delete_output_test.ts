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

import { assertEquals } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  renderWorkflowDelete,
  renderWorkflowDeleteCancelled,
  type WorkflowDeleteData,
} from "./workflow_delete_output.ts";

await initializeLogging({});

const testData: WorkflowDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-workflow",
  workflowPath:
    ".swamp/workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
  runsDeleted: 0,
};

const testDataWithRuns: WorkflowDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-workflow",
  workflowPath:
    ".swamp/workflows/workflow-550e8400-e29b-41d4-a716-446655440000.yaml",
  runsDeleted: 5,
};

Deno.test("renderWorkflowDelete with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowDelete(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.deleted.id, testData.id);
    assertEquals(parsed.deleted.name, testData.name);
    assertEquals(parsed.deleted.workflowPath, testData.workflowPath);
    assertEquals(parsed.runsDeleted, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderWorkflowDelete with json mode includes runsDeleted count", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowDelete(testDataWithRuns, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.runsDeleted, 5);
  } finally {
    console.log = originalLog;
  }
});

Deno.test(
  "renderWorkflowDeleteCancelled does not throw in log mode",
  () => {
    renderWorkflowDeleteCancelled("log");
  },
);

Deno.test("renderWorkflowDeleteCancelled outputs JSON in json mode", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowDeleteCancelled("json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.cancelled, true);
  } finally {
    console.log = originalLog;
  }
});
