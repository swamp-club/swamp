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
import {
  type ModelDefinition,
  modelRegistry,
} from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  toMethodDescribeData,
  zodToJsonSchema,
} from "../types/schema_helpers.ts";
import { createModelTypeDetailLookup, modelTypeDetail } from "./type_detail.ts";

function testModelDef(type: ModelType): ModelDefinition {
  return {
    type,
    version: "2026.01.01.1",
    globalArguments: z.object({ region: z.string() }),
    methods: {
      run: {
        description: "runs it",
        arguments: z.object({ message: z.string() }),
        execute: () => Promise.resolve({}),
      },
    },
  };
}

Deno.test("modelTypeDetail: describes the type's methods and global arguments schema", () => {
  const def = testModelDef(ModelType.create("test/type-detail"));
  assertEquals(modelTypeDetail(def), {
    globalArgumentsSchema: zodToJsonSchema(def.globalArguments!),
    methods: [toMethodDescribeData("run", def.methods.run)],
  });
});

Deno.test("modelTypeDetail: an unavailable type has neither methods nor schema", () => {
  assertEquals(modelTypeDetail(undefined), {
    globalArgumentsSchema: undefined,
    methods: undefined,
  });
});

Deno.test("createModelTypeDetailLookup: resolves a registered type by its name", async () => {
  const type = ModelType.create(
    `@test-type-detail/registered-${crypto.randomUUID().slice(0, 8)}`,
  );
  const def = testModelDef(type);
  modelRegistry.register(def);
  try {
    const lookup = await createModelTypeDetailLookup();
    assertEquals(await lookup(type.normalized), modelTypeDetail(def));
  } finally {
    modelRegistry.invalidateType(type);
  }
});

Deno.test("createModelTypeDetailLookup: an unregistered type yields an empty detail", async () => {
  const lookup = await createModelTypeDetailLookup();
  assertEquals(
    await lookup(`test-type-detail/missing-${crypto.randomUUID().slice(0, 8)}`),
    { globalArgumentsSchema: undefined, methods: undefined },
  );
});
