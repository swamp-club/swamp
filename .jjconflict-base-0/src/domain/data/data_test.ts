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

import { assertEquals, assertThrows } from "@std/assert";
import { Data } from "./data.ts";
import type { OwnerDefinition } from "./data_metadata.ts";

function createTestOwner(): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: "test/model:test-method",
  };
}

Deno.test("Data.create generates UUID if not provided", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(typeof data.id, "string");
  assertEquals(data.id.length, 36);
});

Deno.test("Data.create uses provided ID", () => {
  const owner = createTestOwner();
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const data = Data.create({
    id,
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.id, id);
});

Deno.test("Data.create sets default version to 1", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.version, 1);
});

Deno.test("Data.create uses provided version", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    version: 3,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.version, 3);
});

Deno.test("Data.create sets createdAt to now if not provided", () => {
  const owner = createTestOwner();
  const before = new Date();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  const after = new Date();

  assertEquals(data.createdAt >= before, true);
  assertEquals(data.createdAt <= after, true);
});

Deno.test("Data.create uses provided createdAt", () => {
  const owner = createTestOwner();
  const createdAt = new Date("2023-01-01T00:00:00Z");
  const data = Data.create({
    name: "test-data",
    createdAt,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.createdAt.getTime(), createdAt.getTime());
});

Deno.test("Data.create requires type tag in tags", () => {
  const owner = createTestOwner();
  assertThrows(
    () =>
      Data.create({
        name: "test-data",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { notType: "value" },
        ownerDefinition: owner,
      }),
    Error,
    "tags must include 'type' key",
  );
});

Deno.test("Data.create validates duration lifetime format", () => {
  const owner = createTestOwner();
  // Valid durations should work
  const dataHours = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "24h",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(dataHours.lifetime, "24h");

  const dataDays = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "7d",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(dataDays.lifetime, "7d");

  const dataWeeks = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "2w",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(dataWeeks.lifetime, "2w");
});

Deno.test("Data.create validates special lifetime values", () => {
  const owner = createTestOwner();

  const dataEphemeral = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "ephemeral",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(dataEphemeral.lifetime, "ephemeral");

  const dataInfinite = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(dataInfinite.lifetime, "infinite");

  const dataJob = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "job",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(dataJob.lifetime, "job");

  const dataWorkflow = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "workflow",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(dataWorkflow.lifetime, "workflow");
});

Deno.test("Data.create throws on invalid lifetime format", () => {
  const owner = createTestOwner();
  assertThrows(
    () =>
      Data.create({
        name: "test-data",
        contentType: "text/plain",
        lifetime: "invalid" as "infinite",
        garbageCollection: 5,
        tags: { type: "test" },
        ownerDefinition: owner,
      }),
    Error,
  );
});

Deno.test("Data toData/fromData roundtrip", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "application/json",
    lifetime: "7d",
    garbageCollection: 10,
    streaming: true,
    tags: { type: "log", source: "test" },
    ownerDefinition: owner,
    size: 1024,
    checksum: "abc123",
  });

  const serialized = data.toData();
  const restored = Data.fromData(serialized);

  assertEquals(restored.id, data.id);
  assertEquals(restored.name, data.name);
  assertEquals(restored.version, data.version);
  assertEquals(restored.contentType, data.contentType);
  assertEquals(restored.lifetime, data.lifetime);
  assertEquals(restored.garbageCollection, data.garbageCollection);
  assertEquals(restored.streaming, data.streaming);
  assertEquals(restored.tags, data.tags);
  assertEquals(restored.ownerDefinition, data.ownerDefinition);
  assertEquals(restored.createdAt.getTime(), data.createdAt.getTime());
  assertEquals(restored.size, data.size);
  assertEquals(restored.checksum, data.checksum);
});

Deno.test("Data.isOwnedBy validates ownerType and ownerRef", () => {
  const owner1 = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner1,
  });

  // Same owner should match
  assertEquals(data.isOwnedBy(owner1), true);

  // Different ownerRef should not match
  const owner2: OwnerDefinition = {
    ownerType: "model-method",
    ownerRef: "other/model:other-method",
  };
  assertEquals(data.isOwnedBy(owner2), false);

  // Different ownerType should not match
  const owner3: OwnerDefinition = {
    ownerType: "workflow-step",
    ownerRef: "test/model:test-method",
  };
  assertEquals(data.isOwnedBy(owner3), false);

  // Same ownerType + ownerRef matches even without definitionHash
  const owner4: OwnerDefinition = {
    ownerType: "model-method",
    ownerRef: "test/model:test-method",
  };
  assertEquals(data.isOwnedBy(owner4), true);
});

Deno.test("Data.type returns type tag", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });
  assertEquals(data.type, "resource");
});

Deno.test("Data.withNewVersion creates new version", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });

  const newVersion = data.withNewVersion({
    version: 2,
    size: 2048,
    checksum: "newchecksum",
  });

  assertEquals(newVersion.id, data.id);
  assertEquals(newVersion.name, data.name);
  assertEquals(newVersion.version, 2);
  assertEquals(newVersion.contentType, data.contentType);
  assertEquals(newVersion.lifetime, data.lifetime);
  assertEquals(newVersion.garbageCollection, data.garbageCollection);
  assertEquals(newVersion.tags, data.tags);
  assertEquals(newVersion.ownerDefinition, data.ownerDefinition);
  assertEquals(newVersion.size, 2048);
  assertEquals(newVersion.checksum, "newchecksum");
});

Deno.test("Data.create with garbage collection as version count", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.garbageCollection, 5);
});

Deno.test("Data.create with garbage collection as duration", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: "30d",
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.garbageCollection, "30d");
});

Deno.test("Data.create rejects name with '..'", () => {
  const owner = createTestOwner();
  assertThrows(
    () =>
      Data.create({
        name: "../escape",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "test" },
        ownerDefinition: owner,
      }),
    Error,
    "path traversal",
  );
});

Deno.test("Data.create rejects name with '/'", () => {
  const owner = createTestOwner();
  assertThrows(
    () =>
      Data.create({
        name: "foo/bar",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "test" },
        ownerDefinition: owner,
      }),
    Error,
    "path traversal",
  );
});

Deno.test("Data.create rejects name with '\\'", () => {
  const owner = createTestOwner();
  assertThrows(
    () =>
      Data.create({
        name: "foo\\bar",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "test" },
        ownerDefinition: owner,
      }),
    Error,
    "path traversal",
  );
});

Deno.test("Data.create rejects name with null byte", () => {
  const owner = createTestOwner();
  assertThrows(
    () =>
      Data.create({
        name: "foo\0bar",
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "test" },
        ownerDefinition: owner,
      }),
    Error,
    "path traversal",
  );
});

Deno.test("Data.create accepts valid names with hyphens, dots, and underscores", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "my-data.v2_final",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.name, "my-data.v2_final");
});

Deno.test("Data.create defaults streaming to false", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.streaming, false);
});

Deno.test("Data.create uses provided streaming value", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    streaming: true,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.streaming, true);
});

// --- Zero-duration lifetime normalization in Data.create ---

Deno.test("Data.create normalizes '0h' lifetime to 'workflow'", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "0h",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.lifetime, "workflow");
});

Deno.test("Data.create normalizes '0d' lifetime to 'workflow'", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "0d",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.lifetime, "workflow");
});

Deno.test("Data.create normalizes '0mo' lifetime to 'workflow'", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "0mo",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.lifetime, "workflow");
});

Deno.test("Data.create normalizes '00w' lifetime to 'workflow'", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "00w",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.lifetime, "workflow");
});

Deno.test("Data.create does not normalize non-zero durations", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "7d",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
  assertEquals(data.lifetime, "7d");
});

// --- Zero-duration lifetime normalization in Data.fromData ---

Deno.test("Data.fromData normalizes '0h' lifetime to 'workflow'", () => {
  const owner = createTestOwner();
  const original = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "1h",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });

  // Simulate on-disk data that was saved with "0h" before the fix
  const persisted = original.toData();
  persisted.lifetime = "0h";

  const restored = Data.fromData(persisted);
  assertEquals(restored.lifetime, "workflow");
});

Deno.test("Data.fromData normalizes '0d' lifetime to 'workflow'", () => {
  const owner = createTestOwner();
  const original = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "1d",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });

  const persisted = original.toData();
  persisted.lifetime = "0d";

  const restored = Data.fromData(persisted);
  assertEquals(restored.lifetime, "workflow");
});

Deno.test("Data.fromData preserves non-zero lifetime", () => {
  const owner = createTestOwner();
  const original = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "7d",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });

  const persisted = original.toData();
  const restored = Data.fromData(persisted);
  assertEquals(restored.lifetime, "7d");
});

Deno.test("Data.fromData preserves 'workflow' lifetime", () => {
  const owner = createTestOwner();
  const original = Data.create({
    name: "test-data",
    contentType: "text/plain",
    lifetime: "workflow",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });

  const persisted = original.toData();
  const restored = Data.fromData(persisted);
  assertEquals(restored.lifetime, "workflow");
});

// --- Roundtrip with zero-duration normalization ---

Deno.test("Data roundtrip normalizes zero-duration: create with '0h' -> toData -> fromData -> 'workflow'", () => {
  const owner = createTestOwner();
  const data = Data.create({
    name: "roundtrip-test",
    contentType: "application/json",
    lifetime: "0h",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: owner,
  });

  assertEquals(data.lifetime, "workflow");

  const serialized = data.toData();
  assertEquals(serialized.lifetime, "workflow");

  const restored = Data.fromData(serialized);
  assertEquals(restored.lifetime, "workflow");
});
