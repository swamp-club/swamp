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
 * Contract tests for Data cross-context boundaries.
 *
 * These test behavioral invariants NOT covered by the unit tests in
 * data_test.ts. The unit tests cover creation, validation, path traversal,
 * lifetimes, serialization, and basic ownership. These contract tests verify:
 * - GC schema boundary conditions (zero, float, negative duration)
 * - Ownership schema strictness (enum, non-empty ref)
 * - OwnerDefinition optional fields behavior
 * - withNewVersion preserves all inherited fields
 * - Tags immutability (returned tags are copies)
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  GarbageCollectionSchema,
  OwnerDefinitionSchema,
} from "./data_metadata.ts";
import { Data } from "./data.ts";

// ============================================================================
// GarbageCollection boundary conditions (not in data_test.ts)
// ============================================================================

Deno.test("contract: GarbageCollectionSchema rejects zero integer", () => {
  assertThrows(() => GarbageCollectionSchema.parse(0));
});

Deno.test("contract: GarbageCollectionSchema rejects negative integer", () => {
  assertThrows(() => GarbageCollectionSchema.parse(-5));
});

Deno.test("contract: GarbageCollectionSchema rejects float", () => {
  assertThrows(() => GarbageCollectionSchema.parse(2.5));
});

Deno.test("contract: GarbageCollectionSchema rejects zero-duration string", () => {
  assertThrows(() => GarbageCollectionSchema.parse("0d"));
});

Deno.test("contract: GarbageCollectionSchema accepts positive integer", () => {
  assertEquals(GarbageCollectionSchema.parse(10), 10);
});

Deno.test("contract: GarbageCollectionSchema accepts valid duration string", () => {
  assertEquals(GarbageCollectionSchema.parse("30d"), "30d");
});

// ============================================================================
// OwnerDefinition schema (not in data_test.ts)
// ============================================================================

Deno.test("contract: OwnerDefinitionSchema rejects invalid ownerType", () => {
  assertThrows(() => {
    OwnerDefinitionSchema.parse({ ownerType: "invalid", ownerRef: "ref" });
  });
});

Deno.test("contract: OwnerDefinitionSchema rejects empty ownerRef", () => {
  assertThrows(() => {
    OwnerDefinitionSchema.parse({
      ownerType: "model-method",
      ownerRef: "",
    });
  });
});

Deno.test("contract: OwnerDefinitionSchema accepts all valid ownerTypes", () => {
  for (const ownerType of ["model-method", "workflow-step", "manual"]) {
    const result = OwnerDefinitionSchema.parse({
      ownerType,
      ownerRef: "some-ref",
    });
    assertEquals(result.ownerType, ownerType);
  }
});

Deno.test("contract: OwnerDefinitionSchema optional workflow fields", () => {
  const withWorkflow = OwnerDefinitionSchema.parse({
    ownerType: "workflow-step",
    ownerRef: "job/step",
    workflowId: crypto.randomUUID(),
    workflowRunId: crypto.randomUUID(),
  });
  assert(withWorkflow.workflowId !== undefined);
  assert(withWorkflow.workflowRunId !== undefined);

  const withoutWorkflow = OwnerDefinitionSchema.parse({
    ownerType: "model-method",
    ownerRef: "ref",
  });
  assertEquals(withoutWorkflow.workflowId, undefined);
  assertEquals(withoutWorkflow.workflowRunId, undefined);
});

// ============================================================================
// withNewVersion behavioral contract (not fully covered in data_test.ts)
// ============================================================================

Deno.test("contract: withNewVersion preserves all inherited fields", () => {
  const original = Data.create({
    name: "my-data",
    contentType: "application/json",
    lifetime: "1h",
    garbageCollection: 10,
    streaming: true,
    tags: { type: "resource", env: "prod" },
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: "deploy/apply",
      workflowId: crypto.randomUUID(),
    },
  });

  const v2 = original.withNewVersion({ version: 2, size: 1024 });

  assertEquals(v2.id, original.id);
  assertEquals(v2.name, original.name);
  assertEquals(v2.contentType, original.contentType);
  assertEquals(v2.lifetime, original.lifetime);
  assertEquals(v2.garbageCollection, original.garbageCollection);
  assertEquals(v2.streaming, original.streaming);
  assertEquals(v2.tags, original.tags);
  assertEquals(
    v2.ownerDefinition.ownerType,
    original.ownerDefinition.ownerType,
  );
  assertEquals(v2.ownerDefinition.ownerRef, original.ownerDefinition.ownerRef);

  // New version-specific fields
  assertEquals(v2.version, 2);
  assertEquals(v2.size, 1024);
});

// ============================================================================
// Tags reference semantics contract
// ============================================================================

Deno.test("contract: toData returns a copy of tags (not shared reference)", () => {
  const data = Data.create({
    name: "test",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource", env: "prod" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "ref" },
  });

  // toData() spreads tags, so mutating the output shouldn't affect the entity
  const serialized = data.toData();
  serialized.tags.env = "HACKED";

  assertEquals(data.tags.env, "prod");
});

// ============================================================================
// Ownership edge cases
// ============================================================================

Deno.test("contract: isOwnedBy ignores optional fields in comparison", () => {
  const data = Data.create({
    name: "test",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: {
      ownerType: "workflow-step",
      ownerRef: "job/step",
      workflowId: crypto.randomUUID(),
    },
  });

  // isOwnedBy only checks ownerType + ownerRef, not workflowId
  assert(
    data.isOwnedBy({
      ownerType: "workflow-step",
      ownerRef: "job/step",
    }),
  );
});
