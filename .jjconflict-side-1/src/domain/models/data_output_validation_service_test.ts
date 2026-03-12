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
import { DataOutputValidationService } from "./data_output_validation_service.ts";
import type { DataHandle } from "./model.ts";
import type { DataId } from "../data/data_id.ts";

/**
 * Creates a test DataHandle with the given spec name and kind.
 */
function createTestHandle(
  name: string,
  specName: string,
  kind: "resource" | "file" = "resource",
): DataHandle {
  return {
    name,
    specName,
    kind,
    dataId: `mock-data-${name}` as DataId,
    version: 1,
    size: 0,
    tags: { type: "data" },
    metadata: {
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      streaming: false,
      tags: { type: "data" },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: "test",
      },
    },
  };
}

Deno.test("DataOutputValidationService - validate - accepts valid handles", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("foo-message", "message", "resource"),
    createTestHandle("bar-log", "log", "file"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - passes for handles with any spec name", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("foo-unknown", "unknown", "resource"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - detects duplicate instance names", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("duplicate", "message", "resource"),
    createTestHandle("duplicate", "message", "resource"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
  assertEquals(
    result.errors[0],
    "Duplicate data instance name 'duplicate'",
  );
});

Deno.test("DataOutputValidationService - validate - same specName with different names passes (factory model)", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("subnet-a", "subnet", "resource"),
    createTestHandle("subnet-b", "subnet", "resource"),
    createTestHandle("subnet-c", "subnet", "resource"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("DataOutputValidationService - validate - same override names from different specs fails", () => {
  const service = new DataOutputValidationService();

  const dataHandles: DataHandle[] = [
    createTestHandle("shared-name", "spec-a", "resource"),
    createTestHandle("shared-name", "spec-b", "resource"),
  ];

  const result = service.validate(dataHandles);

  assertEquals(result.valid, false);
  assertEquals(result.errors.length, 1);
});
