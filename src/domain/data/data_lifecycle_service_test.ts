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
import { DefaultDataLifecycleService } from "./data_lifecycle_service.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";

// Mock repositories for testing
class MockDataRepository {
  findByName = () => Promise.resolve(null);
  findAllGlobal: () => Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > = () => Promise.resolve([]);
  listVersions = (): Promise<number[]> => Promise.resolve([]);
  removeLatestMarker = () => Promise.resolve();
  collectGarbageCalls: Array<{
    type: ModelType;
    modelId: string;
    dryRun: boolean;
  }> = [];
  collectGarbage = (
    type: ModelType,
    modelId: string,
    options?: { dryRun?: boolean },
  ) => {
    this.collectGarbageCalls.push({
      type,
      modelId,
      dryRun: options?.dryRun ?? false,
    });
    return Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 });
  };
  deleteCalls: Array<{
    type: ModelType;
    modelId: string;
    dataName: string;
    version?: number;
  }> = [];
  delete = (
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ) => {
    this.deleteCalls.push({ type, modelId, dataName, version });
    return Promise.resolve();
  };
  getContentPath = (
    _type: ModelType,
    _modelId: string,
    _dataName: string,
    _version: number,
  ): string => "/tmp/fake-content-path";
}

class MockWorkflowRunRepository {
  findById = () => Promise.resolve(null);
}

Deno.test("calculateExpiration - returns null for infinite lifetime", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("infinite", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - returns null for ephemeral lifetime", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("ephemeral", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - returns null for workflow lifetime", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("workflow", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - returns null for job lifetime", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("job", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - calculates expiration for 1h duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("1h", createdAt);

  assertEquals(expiration, new Date("2025-01-01T01:00:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 5m duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("5m", createdAt);

  assertEquals(expiration, new Date("2025-01-01T00:05:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 10d duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("10d", createdAt);

  assertEquals(expiration, new Date("2025-01-11T00:00:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 2w duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("2w", createdAt);

  assertEquals(expiration, new Date("2025-01-15T00:00:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 1mo duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("1mo", createdAt);

  // 30 days = 30 * 24 * 60 * 60 * 1000 ms
  const expected = new Date(
    createdAt.getTime() + 30 * 24 * 60 * 60 * 1000,
  );
  assertEquals(expiration, expected);
});

Deno.test("calculateExpiration - calculates expiration for 1y duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("1y", createdAt);

  // 365 days = 365 * 24 * 60 * 60 * 1000 ms
  const expected = new Date(
    createdAt.getTime() + 365 * 24 * 60 * 60 * 1000,
  );
  assertEquals(expiration, expected);
});

function createMockData(overrides: {
  name: string;
  lifetime?: string;
  createdAt?: Date;
}): Data {
  return Data.create({
    name: overrides.name,
    contentType: "application/json",
    lifetime: overrides.lifetime ?? "1h",
    garbageCollection: 5,
    tags: { type: "test" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test-ref" },
    createdAt: overrides.createdAt ?? new Date("2020-01-01T00:00:00Z"),
  });
}

// --- Zero-duration lifetime normalization via Data.create ---

Deno.test("calculateExpiration - Data.create with '0h' produces workflow lifetime (null expiration)", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  // Data.create normalizes "0h" to "workflow"
  const data = createMockData({ name: "zero-hours", lifetime: "0h" });
  assertEquals(data.lifetime, "workflow");

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration(data.lifetime, createdAt);
  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - Data.create with '0d' produces workflow lifetime (null expiration)", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const data = createMockData({ name: "zero-days", lifetime: "0d" });
  assertEquals(data.lifetime, "workflow");

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration(data.lifetime, createdAt);
  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - Data.create with '0mo' produces workflow lifetime (null expiration)", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const data = createMockData({ name: "zero-months", lifetime: "0mo" });
  assertEquals(data.lifetime, "workflow");

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration(data.lifetime, createdAt);
  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - Data.create with '0y' produces workflow lifetime (null expiration)", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const data = createMockData({ name: "zero-years", lifetime: "0y" });
  assertEquals(data.lifetime, "workflow");

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration(data.lifetime, createdAt);
  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - Data.create with '00w' produces workflow lifetime (null expiration)", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  const data = createMockData({ name: "zero-weeks", lifetime: "00w" });
  assertEquals(data.lifetime, "workflow");

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration(data.lifetime, createdAt);
  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - non-zero durations still produce correct expiration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
  );

  // Verify non-zero is unaffected
  const data = createMockData({ name: "valid-hours", lifetime: "2h" });
  assertEquals(data.lifetime, "2h");

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration(data.lifetime, createdAt);
  assertEquals(expiration, new Date("2025-01-01T02:00:00Z"));
});

Deno.test("findExpiredData - finds expired data for nested model types", async () => {
  const mockRepo = new MockDataRepository();
  const expiredData = createMockData({ name: "vpc-data" });
  const nestedType = ModelType.create("aws/ec2/vpc");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      { data: expiredData, modelType: nestedType, modelId: "my-vpc" },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const expired = await service.findExpiredData();

  assertEquals(expired.length, 1);
  assertEquals(expired[0].type, nestedType);
  assertEquals(expired[0].modelId, "my-vpc");
  assertEquals(expired[0].dataName, "vpc-data");
  assertEquals(expired[0].reason, "duration-expired");
});

Deno.test("findExpiredData - finds expired data for two-level nested type", async () => {
  const mockRepo = new MockDataRepository();
  const expiredData = createMockData({ name: "shell-output" });
  const nestedType = ModelType.create("command/shell");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: expiredData,
        modelType: nestedType,
        modelId: "my-shell",
      },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const expired = await service.findExpiredData();

  assertEquals(expired.length, 1);
  assertEquals(expired[0].type.toDirectoryPath(), "command/shell");
  assertEquals(expired[0].modelId, "my-shell");
});

Deno.test("findExpiredData - skips non-expired data", async () => {
  const mockRepo = new MockDataRepository();
  const freshData = createMockData({
    name: "fresh",
    lifetime: "infinite",
  });

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: freshData,
        modelType: ModelType.create("test"),
        modelId: "m1",
      },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const expired = await service.findExpiredData();
  assertEquals(expired.length, 0);
});

Deno.test("findExpiredData - returns empty array when no data exists", async () => {
  const mockRepo = new MockDataRepository();
  mockRepo.findAllGlobal = () => Promise.resolve([]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const expired = await service.findExpiredData();
  assertEquals(expired.length, 0);
});

Deno.test("findExpiredData - skips deletion markers (lifecycle: deleted)", async () => {
  const mockRepo = new MockDataRepository();
  // Create a deleted data entry that would otherwise appear expired
  const deletedData = Data.create({
    name: "deleted-resource",
    contentType: "application/json",
    lifetime: "1h",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test-ref" },
    createdAt: new Date("2020-01-01T00:00:00Z"),
    lifecycle: "deleted",
  });

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: deletedData,
        modelType: ModelType.create("test/model"),
        modelId: "my-resource",
      },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const expired = await service.findExpiredData();
  // Deletion markers should be skipped, not treated as expired
  assertEquals(expired.length, 0);
});

Deno.test("findExpiredData - includes expired active data alongside deleted markers", async () => {
  const mockRepo = new MockDataRepository();
  const expiredActive = createMockData({
    name: "active-expired",
    lifetime: "1h",
  });
  const deletedData = Data.create({
    name: "deleted-resource",
    contentType: "application/json",
    lifetime: "1h",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test-ref" },
    createdAt: new Date("2020-01-01T00:00:00Z"),
    lifecycle: "deleted",
  });

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: expiredActive,
        modelType: ModelType.create("test/model"),
        modelId: "m1",
      },
      {
        data: deletedData,
        modelType: ModelType.create("test/model"),
        modelId: "m2",
      },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const expired = await service.findExpiredData();
  // Only the active expired data should be returned, not the deletion marker
  assertEquals(expired.length, 1);
  assertEquals(expired[0].dataName, "active-expired");
});

Deno.test("deleteExpiredData - hard-deletes expired data via delete()", async () => {
  const mockRepo = new MockDataRepository();
  const expiredData = createMockData({ name: "old-data" });
  const modelType = ModelType.create("test/model");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      { data: expiredData, modelType, modelId: "m1" },
    ]);
  mockRepo.listVersions = () => Promise.resolve([1, 2, 3]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const result = await service.deleteExpiredData();

  // Should call delete() with no version (hard-delete all versions)
  assertEquals(mockRepo.deleteCalls.length, 1);
  assertEquals(mockRepo.deleteCalls[0].modelId, "m1");
  assertEquals(mockRepo.deleteCalls[0].dataName, "old-data");
  assertEquals(mockRepo.deleteCalls[0].version, undefined);

  // Should report the expired entry
  assertEquals(result.dataEntriesExpired, 1);
  assertEquals(result.expiredEntries[0].dataName, "old-data");
  assertEquals(result.expiredEntries[0].versionCount, 3);
  // versionsDeleted includes the 3 versions from the expired entry
  assertEquals(result.versionsDeleted, 3);
});

Deno.test("deleteExpiredData - dry run does not call delete()", async () => {
  const mockRepo = new MockDataRepository();
  const expiredData = createMockData({ name: "old-data" });
  const modelType = ModelType.create("test/model");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      { data: expiredData, modelType, modelId: "m1" },
    ]);
  mockRepo.listVersions = () => Promise.resolve([1, 2]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const result = await service.deleteExpiredData({ dryRun: true });

  // Should NOT call delete in dry run
  assertEquals(mockRepo.deleteCalls.length, 0);
  assertEquals(result.dryRun, true);
  assertEquals(result.dataEntriesExpired, 1);
  // Expired-data byte stat is skipped in dry run, but Phase 2 runs
  // against collectGarbage with dryRun=true (the mock returns 0/0).
  assertEquals(result.versionsDeleted, 0);
  assertEquals(result.bytesReclaimed, 0);
});

Deno.test("deleteExpiredData - dry run passes dryRun=true to collectGarbage", async () => {
  const mockRepo = new MockDataRepository();
  const modelType = ModelType.create("test/model");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: createMockData({ name: "d1", lifetime: "infinite" }),
        modelType,
        modelId: "m1",
      },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  await service.deleteExpiredData({ dryRun: true });

  // Phase 2 should have invoked collectGarbage with dryRun=true for the unique model
  assertEquals(mockRepo.collectGarbageCalls.length, 1);
  assertEquals(mockRepo.collectGarbageCalls[0].modelId, "m1");
  assertEquals(mockRepo.collectGarbageCalls[0].dryRun, true);
});

Deno.test("deleteExpiredData - real run passes dryRun=false to collectGarbage", async () => {
  const mockRepo = new MockDataRepository();
  const modelType = ModelType.create("test/model");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: createMockData({ name: "d1", lifetime: "infinite" }),
        modelType,
        modelId: "m1",
      },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  await service.deleteExpiredData();

  assertEquals(mockRepo.collectGarbageCalls.length, 1);
  assertEquals(mockRepo.collectGarbageCalls[0].dryRun, false);
});

Deno.test("previewVersionGarbage - returns one entry per unique model with pending prunes", async () => {
  const mockRepo = new MockDataRepository();
  const type1 = ModelType.create("test/model-a");
  const type2 = ModelType.create("test/model-b");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: createMockData({ name: "d1", lifetime: "infinite" }),
        modelType: type1,
        modelId: "m1",
      },
      {
        data: createMockData({ name: "d2", lifetime: "infinite" }),
        modelType: type1,
        modelId: "m1",
      },
      {
        data: createMockData({ name: "d3", lifetime: "infinite" }),
        modelType: type2,
        modelId: "m2",
      },
    ]);
  mockRepo.collectGarbage = ((
    type: ModelType,
    modelId: string,
    options?: { dryRun?: boolean },
  ) => {
    mockRepo.collectGarbageCalls.push({
      type,
      modelId,
      dryRun: options?.dryRun ?? false,
    });
    if (modelId === "m1") {
      return Promise.resolve({ versionsRemoved: 5, bytesReclaimed: 1024 });
    }
    return Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 });
  }) as MockDataRepository["collectGarbage"];

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const previews = await service.previewVersionGarbage();

  // Unique models iterated once each
  assertEquals(mockRepo.collectGarbageCalls.length, 2);
  // All calls must be dry-run
  for (const call of mockRepo.collectGarbageCalls) {
    assertEquals(call.dryRun, true);
  }
  // Only m1 has versions to prune
  assertEquals(previews.length, 1);
  assertEquals(previews[0].modelId, "m1");
  assertEquals(previews[0].versionsWouldBeRemoved, 5);
  assertEquals(previews[0].bytesWouldBeReclaimed, 1024);
});

Deno.test("previewVersionGarbage - returns empty when no prunes pending", async () => {
  const mockRepo = new MockDataRepository();
  const modelType = ModelType.create("test/model");

  mockRepo.findAllGlobal = () =>
    Promise.resolve([
      {
        data: createMockData({ name: "d1", lifetime: "infinite" }),
        modelType,
        modelId: "m1",
      },
    ]);

  const service = new DefaultDataLifecycleService(
    mockRepo as never,
    new MockWorkflowRunRepository() as never,
  );

  const previews = await service.previewVersionGarbage();

  assertEquals(previews.length, 0);
});
