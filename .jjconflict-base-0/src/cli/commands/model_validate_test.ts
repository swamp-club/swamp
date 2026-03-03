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

// Note: Full CLI integration tests are in integration/model_validate_test.ts
// These tests verify the command module loads correctly

Deno.test("modelValidateCommand module loads", async () => {
  const { modelValidateCommand } = await import("./model_validate.ts");
  assertEquals(modelValidateCommand.getName(), "validate");
});

Deno.test("modelValidateCommand has correct description", async () => {
  const { modelValidateCommand } = await import("./model_validate.ts");
  assertEquals(
    modelValidateCommand.getDescription(),
    "Validate a model definition against its schema",
  );
});
