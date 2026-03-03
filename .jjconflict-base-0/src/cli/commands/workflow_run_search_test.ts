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
import { applyFilters } from "./workflow_run_search.ts";
import type { WorkflowHistorySearchItem } from "../../presentation/output/workflow_history_search_output.tsx";

function makeItem(
  overrides: Partial<WorkflowHistorySearchItem> = {},
): WorkflowHistorySearchItem {
  return {
    runId: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    workflowName: "test-workflow",
    status: "succeeded",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

Deno.test("applyFilters with --tag filters by matching tags (AND logic)", () => {
  const items = [
    makeItem({ tags: { env: "prod", region: "us-east-1" } }),
    makeItem({ tags: { env: "staging", region: "us-east-1" } }),
    makeItem({ tags: { env: "prod", region: "eu-west-1" } }),
  ];

  const result = applyFilters(items, {
    tags: { env: "prod", region: "us-east-1" },
  });

  assertEquals(result.length, 1);
  assertEquals(result[0].tags?.env, "prod");
  assertEquals(result[0].tags?.region, "us-east-1");
});

Deno.test("applyFilters with --tag single tag filter", () => {
  const items = [
    makeItem({ tags: { env: "prod" } }),
    makeItem({ tags: { env: "staging" } }),
    makeItem({ tags: { env: "prod", team: "platform" } }),
  ];

  const result = applyFilters(items, { tags: { env: "prod" } });

  assertEquals(result.length, 2);
});

Deno.test("applyFilters with --tag items without tags do not match", () => {
  const items = [
    makeItem({ tags: { env: "prod" } }),
    makeItem({}),
    makeItem({ tags: undefined }),
  ];

  const result = applyFilters(items, { tags: { env: "prod" } });

  assertEquals(result.length, 1);
  assertEquals(result[0].tags?.env, "prod");
});

Deno.test("applyFilters without --tag returns all items", () => {
  const items = [
    makeItem({ tags: { env: "prod" } }),
    makeItem({}),
  ];

  const result = applyFilters(items, {});

  assertEquals(result.length, 2);
});
