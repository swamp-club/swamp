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
import { z } from "zod";
import { AWSCloudControlModel } from "./cloud_control_model.ts";
import { ModelType } from "../model_type.ts";
import { modelRegistry } from "../model.ts";

// Test input schema
const TestInputSchema = z.object({
  Name: z.string(),
});

// Concrete implementation for testing
class TestCloudControlModel
  extends AWSCloudControlModel<typeof TestInputSchema> {
  constructor(typeName: string) {
    super({
      typeName,
      modelType: ModelType.create(typeName),
      arguments: TestInputSchema,
      extractResourceIdentifier: (attrs) => attrs.ResourceId as string,
    });
  }
}

Deno.test("AWSCloudControlModel.defineAndRegister registers with global registry", () => {
  // Use unique type name to avoid conflicts
  const typeName = "AWS::Test::DefineAndRegister";
  const model = new TestCloudControlModel(typeName);

  const definition = model.defineAndRegister();

  // Verify the model is registered
  assertEquals(modelRegistry.has(typeName), true);

  // Verify the returned definition has the correct type
  assertEquals(definition.type.raw, typeName);
  assertEquals(definition.type.normalized, "aws/test/defineandregister");
});

Deno.test("AWSCloudControlModel.defineAndRegister returns valid ModelDefinition", () => {
  const typeName = "AWS::Test::ValidDefinition";
  const model = new TestCloudControlModel(typeName);

  const definition = model.defineAndRegister();

  // Verify the definition has the expected structure
  assertEquals(definition.version, "2026.02.09.1");
  assertEquals(typeof definition.methods.create, "object");
  assertEquals(typeof definition.methods.delete, "object");
  assertEquals(typeof definition.methods.sync, "object");
  assertEquals(definition.globalArguments, TestInputSchema);
});

Deno.test("AWSCloudControlModel.defineAndRegister is idempotent", () => {
  const typeName = "AWS::Test::Idempotent";
  const model = new TestCloudControlModel(typeName);

  // Call defineAndRegister twice - should not throw
  const definition1 = model.defineAndRegister();
  const definition2 = model.defineAndRegister();

  // Both calls should return valid definitions
  assertEquals(definition1.type.raw, typeName);
  assertEquals(definition2.type.raw, typeName);

  // The model should still be registered
  assertEquals(modelRegistry.has(typeName), true);
});
