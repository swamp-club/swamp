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

// Mock repositories for testing
class MockDataRepository {
  findByName = () => Promise.resolve(null);
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
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("infinite", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - returns null for ephemeral lifetime", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("ephemeral", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - returns null for workflow lifetime", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("workflow", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - returns null for job lifetime", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("job", createdAt);

  assertEquals(expiration, null);
});

Deno.test("calculateExpiration - calculates expiration for 1h duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("1h", createdAt);

  assertEquals(expiration, new Date("2025-01-01T01:00:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 5m duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("5m", createdAt);

  assertEquals(expiration, new Date("2025-01-01T00:05:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 10d duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("10d", createdAt);

  assertEquals(expiration, new Date("2025-01-11T00:00:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 2w duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("2w", createdAt);

  assertEquals(expiration, new Date("2025-01-15T00:00:00Z"));
});

Deno.test("calculateExpiration - calculates expiration for 1mo duration", () => {
  const service = new DefaultDataLifecycleService(
    new MockDataRepository() as never,
    new MockWorkflowRunRepository() as never,
    "/tmp/test",
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
    "/tmp/test",
  );

  const createdAt = new Date("2025-01-01T00:00:00Z");
  const expiration = service.calculateExpiration("1y", createdAt);

  // 365 days = 365 * 24 * 60 * 60 * 1000 ms
  const expected = new Date(
    createdAt.getTime() + 365 * 24 * 60 * 60 * 1000,
  );
  assertEquals(expiration, expected);
});
