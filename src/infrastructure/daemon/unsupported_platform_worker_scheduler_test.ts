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
import { UserError } from "../../domain/errors.ts";
import { UnsupportedPlatformWorkerScheduler } from "./unsupported_platform_worker_scheduler.ts";

Deno.test("UnsupportedPlatformWorkerScheduler: status is not enabled and names the platform", async () => {
  const scheduler = new UnsupportedPlatformWorkerScheduler("freebsd");
  assertEquals(await scheduler.status(), {
    enabled: false,
    running: false,
    unsupportedReason: "swamp worker daemon is not yet supported on freebsd",
  });
});

Deno.test("UnsupportedPlatformWorkerScheduler: enable rejects with a UserError", async () => {
  const scheduler = new UnsupportedPlatformWorkerScheduler("windows");
  await assertRejects(
    () => scheduler.enable({ binaryPath: "swamp" }),
    UserError,
    "swamp worker daemon is not yet supported on windows",
  );
});

Deno.test("UnsupportedPlatformWorkerScheduler: disable rejects with a UserError", async () => {
  const scheduler = new UnsupportedPlatformWorkerScheduler("windows");
  await assertRejects(
    () => scheduler.disable(),
    UserError,
    "swamp worker daemon is not yet supported on windows",
  );
});
