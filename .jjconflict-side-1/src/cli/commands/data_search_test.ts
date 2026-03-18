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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { filterData, parseDuration, parseTags } from "./data_search.ts";
import type { DataSearchItem } from "../../presentation/output/data_search_output.tsx";
import { UserError } from "../../domain/errors.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

function createTestItem(
  overrides: Partial<DataSearchItem> = {},
): DataSearchItem {
  return {
    id: "test-id-1",
    name: "test-data",
    version: 1,
    contentType: "application/json",
    type: "resource",
    lifetime: "infinite",
    ownerType: "model-method",
    ownerRef: "aws/ec2/vpc:create",
    modelId: "model-1",
    modelName: "my-model",
    modelType: "aws/ec2/vpc",
    streaming: false,
    size: 1024,
    createdAt: new Date().toISOString(),
    tags: { type: "resource" },
    ...overrides,
  };
}

Deno.test("dataSearchCommand module loads", async () => {
  const { dataSearchCommand } = await import("./data_search.ts");
  assertEquals(dataSearchCommand.getName(), "search");
});

Deno.test("dataSearchCommand has correct description", async () => {
  const { dataSearchCommand } = await import("./data_search.ts");
  assertEquals(
    dataSearchCommand.getDescription(),
    "Search for data across all models",
  );
});

Deno.test("dataSearchCommand is registered as subcommand of dataCommand", async () => {
  const { dataCommand } = await import("./data.ts");
  const commands = dataCommand.getCommands();
  const searchCmd = commands.find((c) => c.getName() === "search");
  assertEquals(searchCmd !== undefined, true);
});

Deno.test("filterData with no filters returns all items", () => {
  const items = [
    createTestItem({ name: "a" }),
    createTestItem({ name: "b" }),
    createTestItem({ name: "c" }),
  ];

  const result = filterData(items, {});
  assertEquals(result.length, 3);
});

Deno.test("filterData by type", () => {
  const items = [
    createTestItem({ type: "resource" }),
    createTestItem({ type: "log" }),
    createTestItem({ type: "resource" }),
  ];

  const result = filterData(items, { type: "resource" });
  assertEquals(result.length, 2);
});

Deno.test("filterData by lifetime", () => {
  const items = [
    createTestItem({ lifetime: "infinite" }),
    createTestItem({ lifetime: "ephemeral" }),
    createTestItem({ lifetime: "infinite" }),
  ];

  const result = filterData(items, { lifetime: "ephemeral" });
  assertEquals(result.length, 1);
});

Deno.test("filterData by ownerType", () => {
  const items = [
    createTestItem({ ownerType: "model-method" }),
    createTestItem({ ownerType: "workflow-step" }),
    createTestItem({ ownerType: "manual" }),
  ];

  const result = filterData(items, { ownerType: "workflow-step" });
  assertEquals(result.length, 1);
});

Deno.test("filterData by workflow tag", () => {
  const items = [
    createTestItem({ workflowTag: "deploy" }),
    createTestItem({ workflowTag: "test" }),
    createTestItem({}), // no workflow tag
  ];

  const result = filterData(items, { workflow: "deploy" });
  assertEquals(result.length, 1);
  assertEquals(result[0].workflowTag, "deploy");
});

Deno.test("filterData by model name", () => {
  const items = [
    createTestItem({ modelName: "my-model" }),
    createTestItem({ modelName: "other-model" }),
  ];

  const result = filterData(items, { model: "my-model" });
  assertEquals(result.length, 1);
});

Deno.test("filterData by contentType", () => {
  const items = [
    createTestItem({ contentType: "application/json" }),
    createTestItem({ contentType: "text/plain" }),
  ];

  const result = filterData(items, { contentType: "text/plain" });
  assertEquals(result.length, 1);
});

Deno.test("filterData by streaming", () => {
  const items = [
    createTestItem({ streaming: true }),
    createTestItem({ streaming: false }),
    createTestItem({ streaming: true }),
  ];

  const result = filterData(items, { streaming: true });
  assertEquals(result.length, 2);
});

Deno.test("filterData by since duration", () => {
  const now = Date.now();
  const items = [
    createTestItem({ createdAt: new Date(now - 30 * 60 * 1000).toISOString() }), // 30 min ago
    createTestItem({
      createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    }), // 2 hours ago
    createTestItem({
      createdAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    }), // 25 hours ago
  ];

  const result = filterData(items, { since: "1h" });
  assertEquals(result.length, 1);

  const result2 = filterData(items, { since: "1d" });
  assertEquals(result2.length, 2);
});

Deno.test("filterData with free-text query", () => {
  const items = [
    createTestItem({
      name: "vpc-state",
      modelName: "a",
      ownerRef: "a:b",
      type: "resource",
    }),
    createTestItem({
      name: "subnet-data",
      modelName: "b",
      ownerRef: "c:d",
      type: "log",
    }),
    createTestItem({
      name: "ec2-instance",
      modelName: "c",
      ownerRef: "e:f",
      type: "file",
    }),
  ];

  const result = filterData(items, { query: "vpc" });
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "vpc-state");
});

Deno.test("filterData free-text query matches model name", () => {
  const items = [
    createTestItem({
      modelName: "vpc-model",
      name: "a",
      ownerRef: "a:b",
      type: "log",
    }),
    createTestItem({
      modelName: "other",
      name: "b",
      ownerRef: "c:d",
      type: "file",
    }),
  ];

  const result = filterData(items, { query: "vpc" });
  assertEquals(result.length, 1);
});

Deno.test("filterData free-text query matches ownerRef", () => {
  const items = [
    createTestItem({ ownerRef: "aws/ec2/vpc:create" }),
    createTestItem({ ownerRef: "docker/run:execute" }),
  ];

  const result = filterData(items, { query: "vpc" });
  assertEquals(result.length, 1);
});

Deno.test("filterData with combined filters (AND logic)", () => {
  const items = [
    createTestItem({ type: "resource", lifetime: "infinite" }),
    createTestItem({ type: "resource", lifetime: "ephemeral" }),
    createTestItem({ type: "log", lifetime: "infinite" }),
  ];

  const result = filterData(items, { type: "resource", lifetime: "infinite" });
  assertEquals(result.length, 1);
});

Deno.test("filterData with free-text query AND structured filters", () => {
  const items = [
    createTestItem({
      name: "vpc-state",
      type: "resource",
      modelName: "a",
      ownerRef: "a:b",
    }),
    createTestItem({
      name: "vpc-log",
      type: "log",
      modelName: "b",
      ownerRef: "c:d",
    }),
    createTestItem({
      name: "subnet-state",
      type: "resource",
      modelName: "c",
      ownerRef: "e:f",
    }),
  ];

  const result = filterData(items, { query: "vpc", type: "resource" });
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "vpc-state");
});

Deno.test("filterData with output filter", () => {
  const items = [
    createTestItem({ ownerRef: "my-model:create", id: "output-123" }),
    createTestItem({ ownerRef: "other:run", id: "output-456" }),
  ];

  const result = filterData(items, { output: "output-123" });
  assertEquals(result.length, 1);
});

Deno.test("filterData with run filter", () => {
  const items = [
    createTestItem({ ownerRef: "workflow:job:step-run-abc" }),
    createTestItem({ ownerRef: "workflow:job:step-run-def" }),
  ];

  const result = filterData(items, { run: "run-abc" });
  assertEquals(result.length, 1);
});

Deno.test("parseDuration parses hours", () => {
  assertEquals(parseDuration("1h"), 60 * 60 * 1000);
  assertEquals(parseDuration("24h"), 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration parses days", () => {
  assertEquals(parseDuration("1d"), 24 * 60 * 60 * 1000);
  assertEquals(parseDuration("7d"), 7 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration parses weeks", () => {
  assertEquals(parseDuration("1w"), 7 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration parses months", () => {
  assertEquals(parseDuration("1mo"), 30 * 24 * 60 * 60 * 1000);
});

Deno.test("parseDuration throws on invalid format", () => {
  let threw = false;
  try {
    parseDuration("invalid");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("filterData by single tag", () => {
  const items = [
    createTestItem({ tags: { env: "prod", team: "platform" } }),
    createTestItem({ tags: { env: "dev", team: "platform" } }),
    createTestItem({ tags: { env: "prod", team: "infra" } }),
  ];

  const result = filterData(items, { tags: { env: "prod" } });
  assertEquals(result.length, 2);
});

Deno.test("filterData by multiple tags (AND logic)", () => {
  const items = [
    createTestItem({ tags: { env: "prod", team: "platform" } }),
    createTestItem({ tags: { env: "dev", team: "platform" } }),
    createTestItem({ tags: { env: "prod", team: "infra" } }),
  ];

  const result = filterData(items, { tags: { env: "prod", team: "platform" } });
  assertEquals(result.length, 1);
  assertEquals(result[0].tags.env, "prod");
  assertEquals(result[0].tags.team, "platform");
});

Deno.test("filterData by tag that matches nothing", () => {
  const items = [
    createTestItem({ tags: { env: "prod" } }),
    createTestItem({ tags: { env: "dev" } }),
  ];

  const result = filterData(items, { tags: { env: "staging" } });
  assertEquals(result.length, 0);
});

Deno.test("filterData by tag combined with type filter", () => {
  const items = [
    createTestItem({ tags: { env: "prod" }, type: "resource" }),
    createTestItem({ tags: { env: "prod" }, type: "log" }),
    createTestItem({ tags: { env: "dev" }, type: "resource" }),
  ];

  const result = filterData(items, { tags: { env: "prod" }, type: "resource" });
  assertEquals(result.length, 1);
  assertEquals(result[0].tags.env, "prod");
  assertEquals(result[0].type, "resource");
});

Deno.test("filterData by tag when item lacks the tag key", () => {
  const items = [
    createTestItem({ tags: { env: "prod" } }),
    createTestItem({ tags: { team: "platform" } }), // no "env" key
    createTestItem({ tags: {} }), // empty tags
  ];

  const result = filterData(items, { tags: { env: "prod" } });
  assertEquals(result.length, 1);
  assertEquals(result[0].tags.env, "prod");
});

Deno.test("filterData by tag with empty tags on item filters it out", () => {
  const items = [
    createTestItem({ tags: {} }),
    createTestItem({ tags: {} }),
  ];

  const result = filterData(items, { tags: { env: "prod" } });
  assertEquals(result.length, 0);
});

Deno.test("filterData by tag combined with query filter", () => {
  const items = [
    createTestItem({
      tags: { env: "prod" },
      name: "vpc-state",
      modelName: "a",
      ownerRef: "a:b",
    }),
    createTestItem({
      tags: { env: "prod" },
      name: "subnet-data",
      modelName: "b",
      ownerRef: "c:d",
    }),
    createTestItem({
      tags: { env: "dev" },
      name: "vpc-log",
      modelName: "c",
      ownerRef: "e:f",
    }),
  ];

  const result = filterData(items, { tags: { env: "prod" }, query: "vpc" });
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "vpc-state");
});

Deno.test("filterData by tag combined with multiple structured filters", () => {
  const items = [
    createTestItem({
      tags: { env: "prod" },
      type: "resource",
      lifetime: "infinite",
    }),
    createTestItem({
      tags: { env: "prod" },
      type: "resource",
      lifetime: "ephemeral",
    }),
    createTestItem({
      tags: { env: "prod" },
      type: "log",
      lifetime: "infinite",
    }),
    createTestItem({
      tags: { env: "dev" },
      type: "resource",
      lifetime: "infinite",
    }),
  ];

  const result = filterData(items, {
    tags: { env: "prod" },
    type: "resource",
    lifetime: "infinite",
  });
  assertEquals(result.length, 1);
  assertEquals(result[0].tags.env, "prod");
  assertEquals(result[0].type, "resource");
  assertEquals(result[0].lifetime, "infinite");
});

Deno.test("filterData by tag does not partial-match values", () => {
  const items = [
    createTestItem({ tags: { env: "production" } }),
    createTestItem({ tags: { env: "prod" } }),
  ];

  const result = filterData(items, { tags: { env: "prod" } });
  assertEquals(result.length, 1);
  assertEquals(result[0].tags.env, "prod");
});

// ----- parseTags tests -----

Deno.test("parseTags parses single KEY=VALUE", () => {
  const result = parseTags(["env=prod"]);
  assertEquals(result, { env: "prod" });
});

Deno.test("parseTags parses multiple KEY=VALUE entries", () => {
  const result = parseTags(["env=prod", "team=platform", "region=us-east-1"]);
  assertEquals(result, {
    env: "prod",
    team: "platform",
    region: "us-east-1",
  });
});

Deno.test("parseTags preserves value containing equals sign", () => {
  const result = parseTags(["expr=a=b=c"]);
  assertEquals(result, { expr: "a=b=c" });
});

Deno.test("parseTags throws on missing equals sign", () => {
  assertThrows(
    () => parseTags(["badformat"]),
    UserError,
    'Invalid tag format: "badformat". Expected KEY=VALUE',
  );
});

Deno.test("parseTags throws on empty key (=value)", () => {
  assertThrows(
    () => parseTags(["=value"]),
    UserError,
    'Invalid tag format: "=value". Expected KEY=VALUE',
  );
});

Deno.test("parseTags allows empty value (key=)", () => {
  const result = parseTags(["key="]);
  assertEquals(result, { key: "" });
});

Deno.test("parseTags last value wins for duplicate keys", () => {
  const result = parseTags(["env=prod", "env=dev"]);
  assertEquals(result, { env: "dev" });
});
