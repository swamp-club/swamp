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

/**
 * Contract tests for Definition cross-context boundaries.
 *
 * These test behavioral invariants NOT covered by the unit tests in
 * definition_test.ts. The unit tests cover creation, validation, tags,
 * arguments, serialization, and hashing. These contract tests verify:
 * - Method argument isolation (mutating returned args doesn't affect original)
 * - Upgrade contract (withUpgradedGlobalArguments preserves identity)
 * - Inputs schema round-trip contract (complex schemas survive serialization)
 */

import { assertEquals } from "@std/assert";
import { Definition } from "./definition.ts";

Deno.test("contract: getMethodArguments returns isolated copy per call", () => {
  const def = Definition.create({
    name: "test-def",
    methods: {
      deploy: { arguments: { region: "us-east-1" } },
    },
  });

  const args1 = def.getMethodArguments("deploy");
  const args2 = def.getMethodArguments("deploy");

  // Mutating one copy should not affect the other
  args1.region = "eu-west-1";
  assertEquals(args2.region, "us-east-1");
  assertEquals(def.getMethodArguments("deploy").region, "us-east-1");
});

Deno.test("contract: getMethodArguments for nonexistent method returns empty object", () => {
  const def = Definition.create({ name: "test-def" });
  const args = def.getMethodArguments("nonexistent");
  assertEquals(args, {});
});

Deno.test("contract: withUpgradedGlobalArguments preserves all identity fields", () => {
  const original = Definition.create({
    name: "my-model",
    type: "aws/ec2/instance",
    tags: { env: "prod", team: "infra" },
    methods: {
      create: { arguments: { ami: "ami-123" } },
    },
  });

  const upgraded = Definition.withUpgradedGlobalArguments(
    original,
    { region: "us-west-2", instanceType: "t3.micro" },
    "2025.01",
  );

  // Identity preserved
  assertEquals(upgraded.id, original.id);
  assertEquals(upgraded.name, original.name);
  assertEquals(upgraded.version, original.version);
  assertEquals(upgraded.type, original.type);

  // Tags preserved
  assertEquals(upgraded.tags, original.tags);

  // Methods preserved
  assertEquals(
    upgraded.getMethodArguments("create"),
    original.getMethodArguments("create"),
  );

  // Global arguments replaced (not merged)
  assertEquals(upgraded.globalArguments, {
    region: "us-west-2",
    instanceType: "t3.micro",
  });

  // TypeVersion updated
  assertEquals(upgraded.typeVersion, "2025.01");
});

Deno.test("contract: complex inputs schema survives serialization round-trip", () => {
  const complexInputs = {
    type: "object" as const,
    properties: {
      environments: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            name: { type: "string" as const, description: "Environment name" },
            region: {
              type: "string" as const,
              enum: ["us-east-1", "eu-west-1"],
            },
          },
          required: ["name", "region"],
        },
      },
      dryRun: {
        type: "boolean" as const,
        default: false,
        description: "Skip actual deployment",
      },
    },
    required: ["environments"],
  };

  const def = Definition.create({
    name: "deploy-def",
    inputs: complexInputs,
  });

  const restored = Definition.fromData(def.toData());

  // Deep equality of the complex schema
  assertEquals(restored.inputs, complexInputs);
});

Deno.test("contract: mutating globalArguments after create does not affect definition", () => {
  const args = { region: "us-east-1", count: 3 };
  const def = Definition.create({
    name: "test-def",
    globalArguments: args,
  });

  // Mutate the original object
  args.region = "ap-southeast-1";

  // Definition should be unaffected
  assertEquals(def.globalArguments.region, "us-east-1");
});

Deno.test("contract: setMethodArguments replaces all arguments for a method", () => {
  const def = Definition.create({
    name: "test-def",
    methods: {
      deploy: { arguments: { region: "us-east-1", count: 3 } },
    },
  });

  def.setMethodArguments("deploy", { zone: "a" });
  assertEquals(def.getMethodArguments("deploy"), { zone: "a" });
  // Old arguments are gone
  assertEquals(def.getMethodArguments("deploy").region, undefined);
});
