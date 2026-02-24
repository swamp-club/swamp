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
import { DefaultDataLifecycleService } from "./data_lifecycle_service.ts";
import { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";

// Mock repositories for testing
class MockDataRepository {
  findByName = () => Promise.resolve(null);
  findAllGlobal: () => Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  > = () => Promise.resolve([]);
  listVersions = () => Promise.resolve([]);
  removeLatestSymlink = () => Promise.resolve();
  collectGarbage = () =>
    Promise.resolve({ versionsRemoved: 0, bytesReclaimed: 0 });
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
