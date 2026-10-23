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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

// Import models barrel to trigger self-registration
import "../../domain/models/models.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("skipsPruneConfirmation: --yes and its --force alias each skip the prompt", async () => {
  const { skipsPruneConfirmation } = await import("./worker_prune.ts");
  assertEquals(skipsPruneConfirmation({}), false);
  assertEquals(skipsPruneConfirmation({ yes: true }), true);
  assertEquals(skipsPruneConfirmation({ force: true }), true);
});

Deno.test("workerPruneCommand: declares -y, --yes and describes --force as its alias", async () => {
  const { workerPruneCommand } = await import("./worker_prune.ts");
  assertEquals(workerPruneCommand.getOption("yes")?.flags, ["-y", "--yes"]);
  assertStringIncludes(
    workerPruneCommand.getOption("force")?.description ?? "",
    "(alias for --yes)",
  );
});
