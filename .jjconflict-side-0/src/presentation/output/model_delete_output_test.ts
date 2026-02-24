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
  type ModelDeleteData,
  renderModelDelete,
  renderModelDeleteCancelled,
} from "./model_delete_output.ts";

await initializeLogging({});

const testData: ModelDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  inputPath: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  resourceDeleted: false,
  outputsDeleted: 0,
  evaluatedInputDeleted: false,
  dataDeleted: false,
};

const testDataWithResource: ModelDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  inputPath: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  resourcePath: "resources/swamp/echo/resource-id.yaml",
  resourceDeleted: true,
  outputsDeleted: 0,
  evaluatedInputDeleted: false,
  dataDeleted: false,
};

const testDataWithAllArtifacts: ModelDeleteData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  inputPath: "inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  resourcePath: "resources/swamp/echo/resource-id.yaml",
  resourceDeleted: true,
  outputsDeleted: 5,
  evaluatedInputDeleted: true,
  dataDeleted: true,
};

Deno.test("renderModelDelete with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDelete(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.deleted.id, testData.id);
    assertEquals(parsed.deleted.type, testData.type);
    assertEquals(parsed.deleted.name, testData.name);
    assertEquals(parsed.deleted.inputPath, testData.inputPath);
    assertEquals(parsed.resourceDeleted, false);
    assertEquals(parsed.outputsDeleted, 0);
    assertEquals(parsed.evaluatedInputDeleted, false);
    assertEquals(parsed.dataDeleted, false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelDelete with json mode includes resourcePath when resource deleted", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDelete(testDataWithResource, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(
      parsed.deleted.resourcePath,
      testDataWithResource.resourcePath,
    );
    assertEquals(parsed.resourceDeleted, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelDelete with json mode includes all artifact counts", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDelete(testDataWithAllArtifacts, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.outputsDeleted, 5);
    assertEquals(parsed.evaluatedInputDeleted, true);
    assertEquals(parsed.dataDeleted, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelDeleteCancelled with log mode does not throw", () => {
  renderModelDeleteCancelled("log");
});

Deno.test("renderModelDeleteCancelled outputs JSON in json mode", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelDeleteCancelled("json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.cancelled, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelDelete with log mode does not throw", () => {
  renderModelDelete(testData, "log");
});
