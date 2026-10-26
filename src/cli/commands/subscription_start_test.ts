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

Deno.test("subscriptionStartCommand: description names the billing page", async () => {
  const { subscriptionStartCommand } = await import("./subscription_start.ts");
  assertStringIncludes(
    subscriptionStartCommand.getDescription(),
    "billing page",
  );
});

Deno.test("subscriptionStartCommand: has examples for each way to run it", async () => {
  const { subscriptionStartCommand } = await import("./subscription_start.ts");
  const examples = subscriptionStartCommand.getExamples().map((e) =>
    e.description
  );
  assertEquals(examples, [
    "swamp subscription start",
    "swamp subscription start --collective acme",
    "swamp subscription start --no-browser",
  ]);
});

Deno.test("subscriptionStartCommand: declares --collective and --no-browser", async () => {
  const { subscriptionStartCommand } = await import("./subscription_start.ts");
  const collective = subscriptionStartCommand.getOption("collective");
  const noBrowser = subscriptionStartCommand.getOption("no-browser");
  assertEquals(collective?.flags, ["--collective"]);
  assertEquals(noBrowser?.flags, ["--no-browser"]);
  assertEquals(
    noBrowser?.description,
    "Print the URL instead of opening a browser",
  );
});
