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

import { assertEquals, assertThrows } from "@std/assert";
import { DockerExecutionDriver } from "./docker_execution_driver.ts";
import type { ExecutionDriver, ExecutionRequest } from "./execution_driver.ts";

function createTestRequest(): ExecutionRequest {
  return {
    protocolVersion: 1,
    modelType: "test/model",
    modelId: "test-id",
    methodName: "create",
    globalArgs: {},
    methodArgs: {},
    definitionMeta: {
      id: "def-id",
      name: "test-def",
      version: 1,
      tags: {},
    },
  };
}

Deno.test("ExecutionDriver - type conformance for raw driver", () => {
  // Verify the interface contract is satisfied using a minimal mock
  const driver: ExecutionDriver = {
    type: "raw",
    execute: () =>
      Promise.resolve({
        status: "success" as const,
        outputs: [],
        logs: [],
        durationMs: 0,
      }),
  };
  assertEquals(driver.type, "raw");
});

Deno.test("ExecutionDriver - type conformance for docker driver stub", () => {
  const driver: ExecutionDriver = new DockerExecutionDriver();
  assertEquals(driver.type, "docker");
});

Deno.test("DockerExecutionDriver - execute throws not implemented", () => {
  const driver = new DockerExecutionDriver();

  assertThrows(
    () => driver.execute(createTestRequest()),
    Error,
    "not yet implemented",
  );
});
