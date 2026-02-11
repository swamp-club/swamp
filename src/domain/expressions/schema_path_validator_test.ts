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
import {
  formatAvailableKeys,
  validateSchemaPath,
} from "./schema_path_validator.ts";

// Test schema definitions

const SimpleSchema = z.object({
  name: z.string(),
  count: z.number(),
});

const NestedSchema = z.object({
  attributes: z.object({
    VpcId: z.string(),
    CidrBlock: z.string(),
    Tags: z.array(z.object({
      Key: z.string(),
      Value: z.string(),
    })),
  }),
  metadata: z.object({
    createdAt: z.string(),
  }),
});

const OptionalSchema = z.object({
  required: z.string(),
  optional: z.string().optional(),
  nullable: z.string().nullable(),
});

const RecordSchema = z.object({
  data: z.record(z.string(), z.string()),
});

const UnionSchema = z.object({
  config: z.union([
    z.object({ type: z.literal("a"), valueA: z.string() }),
    z.object({ type: z.literal("b"), valueB: z.number() }),
  ]),
});

// validateSchemaPath tests - valid paths

Deno.test("validateSchemaPath returns valid for empty path", () => {
  const result = validateSchemaPath(SimpleSchema, []);
  assertEquals(result.valid, true);
  assertEquals(result.error, undefined);
});

Deno.test("validateSchemaPath returns valid for simple property access", () => {
  const result = validateSchemaPath(SimpleSchema, ["name"]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for nested property access", () => {
  const result = validateSchemaPath(NestedSchema, ["attributes", "VpcId"]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for deeply nested path", () => {
  const result = validateSchemaPath(NestedSchema, ["metadata", "createdAt"]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for array element access", () => {
  const result = validateSchemaPath(NestedSchema, ["attributes", "Tags", "0"]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for array element property access", () => {
  const result = validateSchemaPath(NestedSchema, [
    "attributes",
    "Tags",
    "0",
    "Key",
  ]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for optional property", () => {
  const result = validateSchemaPath(OptionalSchema, ["optional"]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for nullable property", () => {
  const result = validateSchemaPath(OptionalSchema, ["nullable"]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for record access", () => {
  // Records allow any string key
  const result = validateSchemaPath(RecordSchema, ["data", "anyKey"]);
  assertEquals(result.valid, true);
});

Deno.test("validateSchemaPath returns valid for union member property", () => {
  const result = validateSchemaPath(UnionSchema, ["config", "valueA"]);
  assertEquals(result.valid, true);
});

// validateSchemaPath tests - invalid paths

Deno.test("validateSchemaPath returns invalid for non-existent property", () => {
  const result = validateSchemaPath(SimpleSchema, ["nonExistent"]);
  assertEquals(result.valid, false);
  assertEquals(result.error?.includes("nonExistent"), true);
  assertEquals(result.error?.includes("not found"), true);
});

Deno.test("validateSchemaPath returns invalid for typo with suggestion", () => {
  const result = validateSchemaPath(NestedSchema, ["attributes", "vpcID"]);
  assertEquals(result.valid, false);
  assertEquals(result.suggestion?.includes("VpcId"), true);
});

Deno.test("validateSchemaPath returns invalid for wrong nested property", () => {
  const result = validateSchemaPath(NestedSchema, [
    "attributes",
    "NonExistent",
  ]);
  assertEquals(result.valid, false);
  assertEquals(result.availableKeys?.includes("VpcId"), true);
  assertEquals(result.availableKeys?.includes("CidrBlock"), true);
});

Deno.test("validateSchemaPath returns invalid for array index on non-array", () => {
  const result = validateSchemaPath(SimpleSchema, ["name", "0"]);
  assertEquals(result.valid, false);
  assertEquals(result.error?.includes("non-array"), true);
});

Deno.test("validateSchemaPath returns invalid for property on array without index", () => {
  const result = validateSchemaPath(NestedSchema, [
    "attributes",
    "Tags",
    "Key",
  ]);
  assertEquals(result.valid, false);
  assertEquals(result.error?.includes("not found"), true);
});

Deno.test("validateSchemaPath suggests similar property name", () => {
  const result = validateSchemaPath(NestedSchema, ["atributes"]);
  assertEquals(result.valid, false);
  assertEquals(result.suggestion?.includes("attributes"), true);
});

Deno.test("validateSchemaPath provides available keys on failure", () => {
  const result = validateSchemaPath(SimpleSchema, ["wrong"]);
  assertEquals(result.valid, false);
  assertEquals(result.availableKeys?.length, 2);
  assertEquals(result.availableKeys?.includes("name"), true);
  assertEquals(result.availableKeys?.includes("count"), true);
});

Deno.test("validateSchemaPath handles path at nested failure point", () => {
  const result = validateSchemaPath(NestedSchema, ["attributes", "wrong"]);
  assertEquals(result.valid, false);
  assertEquals(result.error?.includes("attributes"), true);
});

// formatAvailableKeys tests

Deno.test("formatAvailableKeys formats empty array", () => {
  const result = formatAvailableKeys([]);
  assertEquals(result, "");
});

Deno.test("formatAvailableKeys formats single key", () => {
  const result = formatAvailableKeys(["name"]);
  assertEquals(result, "name");
});

Deno.test("formatAvailableKeys formats multiple keys sorted", () => {
  const result = formatAvailableKeys(["count", "name", "age"]);
  assertEquals(result, "age, count, name");
});

Deno.test("formatAvailableKeys truncates with ellipsis when exceeding limit", () => {
  const keys = ["a", "b", "c", "d", "e", "f", "g"];
  const result = formatAvailableKeys(keys, 3);
  assertEquals(result, "a, b, c, ... (4 more)");
});

Deno.test("formatAvailableKeys shows all when at limit", () => {
  const keys = ["a", "b", "c"];
  const result = formatAvailableKeys(keys, 3);
  assertEquals(result, "a, b, c");
});
