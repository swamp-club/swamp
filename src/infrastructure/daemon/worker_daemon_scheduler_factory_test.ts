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

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { createWorkerDaemonScheduler } from "./worker_daemon_scheduler_factory.ts";
import { LaunchdWorkerScheduler } from "./launchd_worker_scheduler.ts";

Deno.test("createWorkerDaemonScheduler: windows status reports not configured with the reason", async () => {
  const scheduler = await createWorkerDaemonScheduler({ os: "windows" });
  const status = await scheduler.status();
  assertEquals(status, {
    enabled: false,
    running: false,
    unsupportedReason: "swamp worker daemon is not yet supported on windows",
  });
});

Deno.test("createWorkerDaemonScheduler: windows enable and disable still refuse", async () => {
  const scheduler = await createWorkerDaemonScheduler({ os: "windows" });
  await assertRejects(
    () => scheduler.enable({ binaryPath: "swamp" }),
    UserError,
    "swamp worker daemon is not yet supported on windows",
  );
  await assertRejects(
    () => scheduler.disable(),
    UserError,
    "swamp worker daemon is not yet supported on windows",
  );
});

Deno.test("createWorkerDaemonScheduler: darwin returns the launchd scheduler", async () => {
  const scheduler = await createWorkerDaemonScheduler({ os: "darwin" });
  assertInstanceOf(scheduler, LaunchdWorkerScheduler);
});
