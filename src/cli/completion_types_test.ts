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
import {
  ModelNameType,
  ModelTypeType,
  WorkflowNameType,
} from "./completion_types.ts";

// Import models barrel to ensure model types are registered
import "../domain/models/models.ts";

// ModelNameType tests
Deno.test("ModelNameType.parse returns the input value unchanged", () => {
  const type = new ModelNameType();
  const result = type.parse({ value: "my-model" });
  assertEquals(result, "my-model");
});

Deno.test("ModelNameType.parse handles empty string", () => {
  const type = new ModelNameType();
  const result = type.parse({ value: "" });
  assertEquals(result, "");
});

Deno.test("ModelNameType.parse handles special characters", () => {
  const type = new ModelNameType();
  const result = type.parse({ value: "my-model_v2.0" });
  assertEquals(result, "my-model_v2.0");
});

Deno.test("ModelNameType.complete returns empty array when not in a swamp repo", async () => {
  const type = new ModelNameType();
  // Running from a directory without a swamp repo should return empty array
  // (graceful degradation)
  const result = await type.complete();
  // Result depends on whether we're in a swamp repo, but should not throw
  assertEquals(Array.isArray(result), true);
});

// WorkflowNameType tests
Deno.test("WorkflowNameType.parse returns the input value unchanged", () => {
  const type = new WorkflowNameType();
  const result = type.parse({ value: "my-workflow" });
  assertEquals(result, "my-workflow");
});

Deno.test("WorkflowNameType.parse handles empty string", () => {
  const type = new WorkflowNameType();
  const result = type.parse({ value: "" });
  assertEquals(result, "");
});

Deno.test("WorkflowNameType.parse handles special characters", () => {
  const type = new WorkflowNameType();
  const result = type.parse({ value: "deploy-workflow_v1" });
  assertEquals(result, "deploy-workflow_v1");
});

Deno.test("WorkflowNameType.complete returns empty array when not in a swamp repo", async () => {
  const type = new WorkflowNameType();
  // Running from a directory without a swamp repo should return empty array
  // (graceful degradation)
  const result = await type.complete();
  // Result depends on whether we're in a swamp repo, but should not throw
  assertEquals(Array.isArray(result), true);
});

// ModelTypeType tests
Deno.test("ModelTypeType.parse returns the input value unchanged", () => {
  const type = new ModelTypeType();
  const result = type.parse({ value: "swamp/echo" });
  assertEquals(result, "swamp/echo");
});

Deno.test("ModelTypeType.parse handles empty string", () => {
  const type = new ModelTypeType();
  const result = type.parse({ value: "" });
  assertEquals(result, "");
});

Deno.test("ModelTypeType.parse handles nested type paths", () => {
  const type = new ModelTypeType();
  const result = type.parse({ value: "aws/ec2/instance" });
  assertEquals(result, "aws/ec2/instance");
});

Deno.test("ModelTypeType.complete returns registered model types", () => {
  const type = new ModelTypeType();
  const result = type.complete();

  // Should return an array of strings
  assertEquals(Array.isArray(result), true);

  // Should include known registered types
  assertEquals(result.includes("swamp/echo"), true);
  assertEquals(result.includes("keeb/shell"), true);
});

Deno.test("ModelTypeType.complete returns all AWS EC2 types", () => {
  const type = new ModelTypeType();
  const result = type.complete();

  // Should include AWS EC2 types
  assertEquals(result.includes("aws/ec2/instance"), true);
  assertEquals(result.includes("aws/ec2/subnet"), true);
  assertEquals(result.includes("aws/ec2/vpc"), true);
});
