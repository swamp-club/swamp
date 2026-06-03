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
import { z } from "zod";
import { buildOutputSpecs } from "./output_spec_builder.ts";
import type { ModelDefinition } from "./model.ts";
import { ModelType } from "./model_type.ts";

function createMinimalModelDef(
  overrides?: Partial<ModelDefinition>,
): ModelDefinition {
  return {
    type: ModelType.create("test/model"),
    version: "2026.01.01.1",
    methods: {
      test: {
        description: "test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
    ...overrides,
  };
}

Deno.test("buildOutputSpecs: returns empty array when no resources or files", () => {
  const modelDef = createMinimalModelDef();
  const specs = buildOutputSpecs(modelDef);
  assertEquals(specs, []);
});

Deno.test("buildOutputSpecs: includes resource specs with schema", () => {
  const modelDef = createMinimalModelDef({
    resources: {
      result: {
        description: "The result",
        schema: z.object({ count: z.number() }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
  });
  const specs = buildOutputSpecs(modelDef);
  assertEquals(specs.length, 1);
  assertEquals(specs[0].specName, "result");
  assertEquals(specs[0].kind, "resource");
  assertEquals(specs[0].description, "The result");
  assertEquals(typeof specs[0].schema, "object");
});

Deno.test("buildOutputSpecs: includes file specs with contentType", () => {
  const modelDef = createMinimalModelDef({
    files: {
      "execution-log": {
        description: "Execution log",
        contentType: "text/plain",
        lifetime: "30d",
        garbageCollection: 3,
      },
    },
  });
  const specs = buildOutputSpecs(modelDef);
  assertEquals(specs.length, 1);
  assertEquals(specs[0].specName, "execution-log");
  assertEquals(specs[0].kind, "file");
  assertEquals(specs[0].description, "Execution log");
  assertEquals(specs[0].contentType, "text/plain");
});

Deno.test("buildOutputSpecs: includes both resource and file specs", () => {
  const modelDef = createMinimalModelDef({
    resources: {
      state: {
        description: "State resource",
        schema: z.object({ status: z.string() }),
        lifetime: "infinite",
        garbageCollection: 5,
      },
    },
    files: {
      log: {
        description: "Log file",
        contentType: "text/plain",
        lifetime: "1d",
        garbageCollection: 1,
      },
    },
  });
  const specs = buildOutputSpecs(modelDef);
  assertEquals(specs.length, 2);
  assertEquals(specs[0].kind, "resource");
  assertEquals(specs[1].kind, "file");
});
