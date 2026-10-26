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

Deno.test("subscriptionStatusCommand: description names the plan and billing standing", async () => {
  const { subscriptionStatusCommand } = await import(
    "./subscription_status.ts"
  );
  assertStringIncludes(
    subscriptionStatusCommand.getDescription(),
    "plan and billing standing",
  );
});

Deno.test("subscriptionStatusCommand: has an example", async () => {
  const { subscriptionStatusCommand } = await import(
    "./subscription_status.ts"
  );
  assertEquals(
    subscriptionStatusCommand.getExamples().some((e) =>
      e.description.includes("swamp subscription status")
    ),
    true,
  );
});

Deno.test("subscriptionCommand: lists status and start", async () => {
  const { subscriptionCommand } = await import("./subscription.ts");
  assertEquals(
    subscriptionCommand.getCommands(false).map((c) => c.getName()),
    ["status", "start"],
  );
});
