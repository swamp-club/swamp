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
  type ModelMethodRunData,
  renderModelMethodRun,
} from "./model_method_run_output.ts";

await initializeLogging({});

const testDataWithResource: ModelMethodRunData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "aws/ec2/instance",
  methodName: "create",
  resource: {
    id: "660e8400-e29b-41d4-a716-446655440000",
    path:
      "/path/to/resources/aws/ec2/instance/660e8400-e29b-41d4-a716-446655440000.yaml",
    attributes: {
      instanceId: "i-1234567890abcdef0",
      state: "running",
    },
  },
};

const testDataWithData: ModelMethodRunData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "swamp/echo",
  methodName: "write",
  data: {
    id: "660e8400-e29b-41d4-a716-446655440000",
    path: "/path/to/data/swamp/echo/660e8400-e29b-41d4-a716-446655440000.yaml",
    attributes: {
      message: "Hello, world!",
      timestamp: "2026-01-28T12:00:00.000Z",
    },
  },
};

Deno.test("renderModelMethodRun with json mode outputs valid JSON for data", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(testDataWithData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelId, testDataWithData.modelId);
    assertEquals(parsed.modelName, testDataWithData.modelName);
    assertEquals(parsed.type, testDataWithData.type);
    assertEquals(parsed.methodName, testDataWithData.methodName);
    assertEquals(parsed.data.id, testDataWithData.data!.id);
    assertEquals(parsed.data.path, testDataWithData.data!.path);
    assertEquals(parsed.data.attributes.message, "Hello, world!");
    assertEquals(
      parsed.data.attributes.timestamp,
      "2026-01-28T12:00:00.000Z",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodRun with json mode outputs valid JSON for resource", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(testDataWithResource, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelId, testDataWithResource.modelId);
    assertEquals(parsed.resource.id, testDataWithResource.resource!.id);
    assertEquals(parsed.resource.attributes.instanceId, "i-1234567890abcdef0");
    assertEquals(parsed.resource.attributes.state, "running");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodRun JSON preserves attribute types", () => {
  const dataWithNumber: ModelMethodRunData = {
    ...testDataWithData,
    data: {
      ...testDataWithData.data!,
      attributes: {
        count: 42,
        enabled: true,
      },
    },
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(dataWithNumber, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.data.attributes.count, 42);
    assertEquals(parsed.data.attributes.enabled, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodRun with log mode does not throw", () => {
  renderModelMethodRun(testDataWithData, "log");
});
