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

import { assertEquals, assertThrows } from "@std/assert";
import { ModelType } from "./model_type.ts";

Deno.test("ModelType.create normalizes AWS-style types", () => {
  const type = ModelType.create("AWS::EC2::VPC");
  assertEquals(type.raw, "AWS::EC2::VPC");
  assertEquals(type.normalized, "aws/ec2/vpc");
  assertEquals(type.toNormalized(), "aws/ec2/vpc");
});

Deno.test("ModelType.create normalizes space-separated types", () => {
  const type = ModelType.create("docker run");
  assertEquals(type.raw, "docker run");
  assertEquals(type.normalized, "docker/run");
});

Deno.test("ModelType.create normalizes dot-separated types", () => {
  const type = ModelType.create("Microsoft.Resources.resourceGroup");
  assertEquals(type.raw, "Microsoft.Resources.resourceGroup");
  assertEquals(type.normalized, "microsoft/resources/resourcegroup");
});

Deno.test("ModelType.create preserves already-normalized types", () => {
  const type = ModelType.create("swamp/echo");
  assertEquals(type.raw, "swamp/echo");
  assertEquals(type.normalized, "swamp/echo");
});

Deno.test("ModelType.create handles mixed separators", () => {
  const type = ModelType.create("Microsoft.Resources/resourceGroup");
  assertEquals(type.normalized, "microsoft/resources/resourcegroup");
});

Deno.test("ModelType.create trims whitespace", () => {
  const type = ModelType.create("  swamp/echo  ");
  assertEquals(type.raw, "swamp/echo");
  assertEquals(type.normalized, "swamp/echo");
});

Deno.test("ModelType.create throws on empty string", () => {
  assertThrows(
    () => ModelType.create(""),
    Error,
    "Model type cannot be empty",
  );
});

Deno.test("ModelType.create throws on whitespace-only string", () => {
  assertThrows(
    () => ModelType.create("   "),
    Error,
    "Model type cannot be empty",
  );
});

Deno.test("ModelType.equals returns true for same normalized types", () => {
  const type1 = ModelType.create("AWS::EC2::VPC");
  const type2 = ModelType.create("aws/ec2/vpc");
  assertEquals(type1.equals(type2), true);
});

Deno.test("ModelType.equals returns false for different types", () => {
  const type1 = ModelType.create("AWS::EC2::VPC");
  const type2 = ModelType.create("swamp/echo");
  assertEquals(type1.equals(type2), false);
});

Deno.test("ModelType.toDirectoryPath returns normalized path", () => {
  const type = ModelType.create("AWS::EC2::VPC");
  assertEquals(type.toDirectoryPath(), "aws/ec2/vpc");
});

Deno.test("ModelType.toString returns raw type", () => {
  const type = ModelType.create("AWS::EC2::VPC");
  assertEquals(type.toString(), "AWS::EC2::VPC");
});

// --- User namespace helper tests ---

Deno.test("ModelType.isUserNamespace returns true for @ prefixed types", () => {
  assertEquals(ModelType.isUserNamespace("@user/foo"), true);
  assertEquals(ModelType.isUserNamespace("@adam/bar"), true);
  assertEquals(ModelType.isUserNamespace("@user/foo/bar"), true);
});

Deno.test("ModelType.isUserNamespace returns false for non-@ types", () => {
  assertEquals(ModelType.isUserNamespace("swamp/echo"), false);
  assertEquals(ModelType.isUserNamespace("aws/ec2/vpc"), false);
  assertEquals(ModelType.isUserNamespace("user/foo"), false);
});

Deno.test("ModelType.getUserNamespace extracts namespace correctly", () => {
  assertEquals(ModelType.getUserNamespace("@user/foo"), "user");
  assertEquals(ModelType.getUserNamespace("@adam/bar"), "adam");
  assertEquals(ModelType.getUserNamespace("@mycompany/cloud/aws"), "mycompany");
  assertEquals(ModelType.getUserNamespace("@user"), "user");
});

Deno.test("ModelType.getUserNamespace returns undefined for non-@ types", () => {
  assertEquals(ModelType.getUserNamespace("swamp/echo"), undefined);
  assertEquals(ModelType.getUserNamespace("user/foo"), undefined);
});

Deno.test("ModelType.getSegmentCount returns correct counts", () => {
  // Built-in types
  assertEquals(ModelType.getSegmentCount("swamp/echo"), 2);
  assertEquals(ModelType.getSegmentCount("aws/ec2/vpc"), 3);
  // User namespace types
  assertEquals(ModelType.getSegmentCount("@user/echo"), 2);
  assertEquals(ModelType.getSegmentCount("@user/foo/bar"), 3);
  assertEquals(ModelType.getSegmentCount("@user/a/b/c/d"), 5);
  // Edge cases
  assertEquals(ModelType.getSegmentCount("@user"), 1);
  assertEquals(ModelType.getSegmentCount("single"), 1);
});

Deno.test("ModelType.isReservedCollective identifies swamp as reserved", () => {
  assertEquals(ModelType.isReservedCollective("swamp/echo"), true);
  assertEquals(ModelType.isReservedCollective("swamp/foo/bar"), true);
  assertEquals(ModelType.isReservedCollective("@swamp/echo"), true);
  assertEquals(ModelType.isReservedCollective("@swamp/foo/bar"), true);
});

Deno.test("ModelType.isReservedCollective identifies si as reserved", () => {
  assertEquals(ModelType.isReservedCollective("si/auth"), true);
  assertEquals(ModelType.isReservedCollective("si/foo/bar"), true);
  assertEquals(ModelType.isReservedCollective("@si/auth"), true);
  assertEquals(ModelType.isReservedCollective("@si/foo/bar"), true);
});

Deno.test("ModelType.isReservedCollective returns false for user collectives", () => {
  assertEquals(ModelType.isReservedCollective("@user/echo"), false);
  assertEquals(ModelType.isReservedCollective("@adam/foo"), false);
  assertEquals(ModelType.isReservedCollective("@mycompany/model"), false);
});

Deno.test("ModelType.isReservedCollective returns false for non-reserved built-in", () => {
  assertEquals(ModelType.isReservedCollective("aws/ec2/vpc"), false);
  assertEquals(ModelType.isReservedCollective("docker/run"), false);
});

// --- Stream-0 regression net: logical-key path separators ---

Deno.test("ModelType.toDirectoryPath: returns forward-slash separators on every OS", () => {
  // ModelType normalizes to a logical key (e.g. "aws/ec2/vpc"). This is
  // a content-addressable identifier, NOT a host filesystem path —
  // every consumer (catalog DB, manifests, registry lookups) expects
  // forward slashes. Stream C is leaving this code alone explicitly;
  // the test pins the contract so a refactor that, say, swaps `/` for
  // `path.SEPARATOR` will fail on Windows.
  const inputs = [
    "AWS::EC2::VPC",
    "Microsoft.Resources.resourceGroup",
    "docker run",
    "@user/aws/ec2",
    "swamp/echo",
  ];
  for (const input of inputs) {
    const t = ModelType.create(input);
    const normalized = t.normalized;
    const directoryPath = t.toDirectoryPath();
    const toNormalized = t.toNormalized();

    assertEquals(
      normalized.includes("\\"),
      false,
      `normalized must not contain backslash for ${input}; got ${normalized}`,
    );
    assertEquals(
      directoryPath.includes("\\"),
      false,
      `toDirectoryPath must not contain backslash for ${input}; got ${directoryPath}`,
    );
    assertEquals(
      toNormalized.includes("\\"),
      false,
      `toNormalized must not contain backslash for ${input}; got ${toNormalized}`,
    );

    // toDirectoryPath and toNormalized must agree: same logical key.
    assertEquals(directoryPath, toNormalized);
    assertEquals(directoryPath, normalized);
  }
});

Deno.test("ModelType.create: multi-segment input always normalizes with forward slashes", () => {
  // Belt-and-braces guard for Stream C. Even on Windows, where
  // path.SEPARATOR is "\\", the logical key from ModelType.create must
  // be forward-slash-separated.
  const t1 = ModelType.create("AWS::EC2::VPC");
  assertEquals(t1.normalized, "aws/ec2/vpc");
  assertEquals(t1.normalized.split("/").length, 3);

  const t2 = ModelType.create("@user/aws/ec2");
  assertEquals(t2.normalized.includes("/"), true);
  assertEquals(t2.normalized.includes("\\"), false);
});

// --- Non-string input guard tests ---

Deno.test("ModelType.create: throws TypeError for undefined input", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => ModelType.create(undefined as any),
    TypeError,
    "ModelType.create() expected a string but received undefined",
  );
});

Deno.test("ModelType.create: throws TypeError for null input", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => ModelType.create(null as any),
    TypeError,
    "ModelType.create() expected a string but received object",
  );
});

Deno.test("ModelType.create: throws TypeError for number input", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => ModelType.create(42 as any),
    TypeError,
    "ModelType.create() expected a string but received number: 42",
  );
});

Deno.test("ModelType.create: throws TypeError for object input", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => ModelType.create({ raw: "test" } as any),
    TypeError,
    "ModelType.create() expected a string but received object",
  );
});
