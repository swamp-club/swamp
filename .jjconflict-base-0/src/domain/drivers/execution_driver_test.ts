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
import { DockerExecutionDriver } from "./docker_execution_driver.ts";
import type { ExecutionDriver } from "./execution_driver.ts";

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

Deno.test("ExecutionDriver - type conformance for docker driver", () => {
  const driver: ExecutionDriver = new DockerExecutionDriver({
    image: "test:latest",
  });
  assertEquals(driver.type, "docker");
});
