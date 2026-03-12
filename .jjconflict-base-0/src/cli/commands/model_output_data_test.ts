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

// Initialize logging for tests
await initializeLogging({});

// Note: Full CLI integration tests are in integration/
// These tests verify the command module loads correctly

Deno.test("modelOutputDataCommand module loads", async () => {
  const { modelOutputDataCommand } = await import("./model_output_data.ts");
  assertEquals(modelOutputDataCommand.getName(), "data");
});

Deno.test("modelOutputDataCommand has correct description", async () => {
  const { modelOutputDataCommand } = await import("./model_output_data.ts");
  assertEquals(
    modelOutputDataCommand.getDescription(),
    "Show data artifact content for a model output",
  );
});
