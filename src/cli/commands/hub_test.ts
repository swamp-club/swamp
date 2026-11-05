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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { UserError } from "../../domain/errors.ts";
import { hubCommand, hubServiceArgs } from "./hub.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

Deno.test("hubServiceArgs: the service hub binds a fixed address and writes the record, with no idle exit", () => {
  const args = hubServiceArgs(
    "/opt/swamp",
    "127.0.0.1:9870",
    "/home/me/.swamp",
  );
  assertEquals(args, [
    "hub",
    "--engine",
    "/opt/swamp",
    "--bind",
    "127.0.0.1:9870",
    "--record",
    join("/home/me/.swamp", "hub", "hub.json"),
  ]);
  assertEquals(args.includes("--exit-when-idle"), false);
});

Deno.test("hubCommand: daemon enable refuses an install without the hub", async () => {
  await withMockedEnv(
    { SWAMP_HUB_ENGINE: undefined, SWAMPD_BINARY: undefined },
    async () => {
      // Tests run under deno, which the hub can't start as its engine.
      await assertRejects(
        () => hubCommand.parse(["daemon", "enable"]),
        UserError,
        "no hub",
      );
    },
  );
});
