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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ModelSearchItem } from "../../presentation/output/model_search_output.tsx";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("modelSearchCommand module loads", async () => {
  const { modelSearchCommand } = await import("./model_search.ts");
  assertEquals(modelSearchCommand.getName(), "search");
});

Deno.test("modelSearchCommand has correct description", async () => {
  const { modelSearchCommand } = await import("./model_search.ts");
  assertEquals(
    modelSearchCommand.getDescription(),
    "Search for model definitions",
  );
});

Deno.test("modelSearchCommand is registered as subcommand of modelCommand", async () => {
  const { modelCommand } = await import("./model_create.ts");
  const commands = modelCommand.getCommands();
  const searchCmd = commands.find((c) => c.getName() === "search");
  assertEquals(searchCmd !== undefined, true);
});

// filterModels tests
Deno.test("filterModels returns all models when query is empty", async () => {
  const { filterModels } = await import("./model_search.ts");
  const models: ModelSearchItem[] = [
    { id: "id-1", name: "model-a", type: "swamp/echo" },
    { id: "id-2", name: "model-b", type: "swamp/echo" },
  ];

  const result = filterModels(models, "");
  assertEquals(result.length, 2);
});

Deno.test("filterModels filters by name (case-insensitive)", async () => {
  const { filterModels } = await import("./model_search.ts");
  const models: ModelSearchItem[] = [
    { id: "id-1", name: "Production-Server", type: "swamp/echo" },
    { id: "id-2", name: "staging-server", type: "swamp/echo" },
    { id: "id-3", name: "dev-database", type: "swamp/echo" },
  ];

  const result = filterModels(models, "server");
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "Production-Server");
  assertEquals(result[1].name, "staging-server");
});

Deno.test("filterModels filters by type", async () => {
  const { filterModels } = await import("./model_search.ts");
  const models: ModelSearchItem[] = [
    { id: "id-1", name: "model-a", type: "swamp/echo" },
    { id: "id-2", name: "model-b", type: "swamp/database" },
    { id: "id-3", name: "model-c", type: "swamp/echo" },
  ];

  const result = filterModels(models, "database");
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "model-b");
});

Deno.test("filterModels filters by id", async () => {
  const { filterModels } = await import("./model_search.ts");
  const models: ModelSearchItem[] = [
    {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "model-a",
      type: "swamp/echo",
    },
    {
      id: "660e8400-e29b-41d4-a716-446655440001",
      name: "model-b",
      type: "swamp/echo",
    },
  ];

  const result = filterModels(models, "550e8400");
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "model-a");
});

Deno.test("filterModels returns empty array when no matches", async () => {
  const { filterModels } = await import("./model_search.ts");
  const models: ModelSearchItem[] = [
    { id: "id-1", name: "model-a", type: "swamp/echo" },
    { id: "id-2", name: "model-b", type: "swamp/echo" },
  ];

  const result = filterModels(models, "nonexistent");
  assertEquals(result.length, 0);
});

Deno.test("filterModels handles empty model list", async () => {
  const { filterModels } = await import("./model_search.ts");
  const models: ModelSearchItem[] = [];

  const result = filterModels(models, "anything");
  assertEquals(result.length, 0);
});
