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
  renderWorkflowSchema,
  type WorkflowSchemaData,
} from "./workflow_schema_output.ts";

await initializeLogging({});

const testData: WorkflowSchemaData = {
  workflow: {
    type: "object",
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string", minLength: 1 },
    },
    required: ["id", "name"],
  },
  job: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      steps: { type: "array" },
    },
    required: ["name", "steps"],
  },
  jobDependency: {
    type: "object",
    properties: {
      job: { type: "string" },
      condition: { type: "object" },
    },
    required: ["job", "condition"],
  },
  step: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      task: { type: "object" },
    },
    required: ["name", "task"],
  },
  stepDependency: {
    type: "object",
    properties: {
      step: { type: "string" },
      condition: { type: "object" },
    },
    required: ["step", "condition"],
  },
  stepTask: {
    oneOf: [
      { type: "object", properties: { type: { const: "model_method" } } },
      { type: "object", properties: { type: { const: "workflow" } } },
    ],
  },
  triggerCondition: {
    oneOf: [
      { type: "object", properties: { type: { const: "always" } } },
      { type: "object", properties: { type: { const: "succeeded" } } },
    ],
  },
};

Deno.test("renderWorkflowSchema with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderWorkflowSchema(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(typeof parsed.workflow, "object");
    assertEquals(typeof parsed.job, "object");
    assertEquals(typeof parsed.step, "object");
    assertEquals(typeof parsed.stepTask, "object");
    assertEquals(typeof parsed.triggerCondition, "object");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderWorkflowSchema with log mode does not throw", () => {
  renderWorkflowSchema(testData, "log");
});
