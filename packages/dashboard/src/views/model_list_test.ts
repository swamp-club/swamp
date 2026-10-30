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
import {
  filterModels,
  modelPrefixOptions,
  type ModelSummary,
  modelTypeOptions,
  sortModels,
} from "./model_list.ts";
import type { ModelUsage } from "./model_executions.ts";

const models: ModelSummary[] = [
  { id: "1", name: "deploy-api", type: "command/shell" },
  { id: "2", name: "deploy-web", type: "@acme/aws/ec2" },
  { id: "3", name: "backup", type: "command/shell" },
  { id: "4", name: "data-export-pipeline", type: "@acme/aws/s3" },
];

const none = { query: "", types: [], prefixes: [] };

Deno.test("filterModels: fuzzy matches the name or the type", () => {
  assertEquals(
    filterModels(models, { ...none, query: "dep api" })[0].id,
    "1",
  );
  assertEquals(
    filterModels(models, { ...none, query: "ec2" }).map((m) => m.id),
    ["2"],
  );
});

Deno.test("filterModels: narrows by exact type and by name prefix", () => {
  assertEquals(
    filterModels(models, { ...none, types: ["command/shell"] }).map((m) =>
      m.id
    ),
    ["1", "3"],
  );
  assertEquals(
    filterModels(models, { ...none, prefixes: ["deploy"] }).map((m) => m.id),
    ["1", "2"],
  );
});

Deno.test("sortModels: by name, by recent use and by executions", () => {
  const usage: Record<string, Partial<ModelUsage>> = {
    "3": { executions: 9, lastStartedAt: "2026-10-01T00:00:00.000Z" },
    "2": { executions: 2, lastStartedAt: "2026-10-12T00:00:00.000Z" },
  };
  const of = (m: ModelSummary) => usage[m.id] as ModelUsage | undefined;
  assertEquals(sortModels(models, "name", of).map((m) => m.id), [
    "3",
    "4",
    "1",
    "2",
  ]);
  assertEquals(sortModels(models, "recent", of).map((m) => m.id), [
    "2",
    "3",
    "4",
    "1",
  ]);
  assertEquals(sortModels(models, "busy", of).map((m) => m.id), [
    "3",
    "2",
    "4",
    "1",
  ]);
  assertEquals(sortModels(models, "relevance", of), models);
});

Deno.test("modelTypeOptions: one option per type with counts", () => {
  assertEquals(modelTypeOptions(models), [
    { value: "@acme/aws/ec2", label: "@acme/aws/ec2", hint: "1" },
    { value: "@acme/aws/s3", label: "@acme/aws/s3", hint: "1" },
    { value: "command/shell", label: "command/shell", hint: "2" },
  ]);
});

Deno.test("modelPrefixOptions: groups names by prefix", () => {
  assertEquals(modelPrefixOptions(models), [
    { value: "data", label: "data", hint: "1" },
    { value: "deploy", label: "deploy", hint: "2" },
  ]);
});
