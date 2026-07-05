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
import { collectWorkerExtraArgs } from "./worker_daemon.ts";

Deno.test("collectWorkerExtraArgs: includes data-plane-url when provided", () => {
  const args = collectWorkerExtraArgs({
    dataPlaneUrl: "https://dp.internal",
  });
  assertEquals(args, ["--data-plane-url", "https://dp.internal"]);
});

Deno.test("collectWorkerExtraArgs: includes no-reconnect when false", () => {
  const args = collectWorkerExtraArgs({ reconnect: false });
  assertEquals(args, ["--no-reconnect"]);
});

Deno.test("collectWorkerExtraArgs: returns empty when no relevant options", () => {
  const args = collectWorkerExtraArgs({});
  assertEquals(args, []);
});

Deno.test("collectWorkerExtraArgs: combines multiple options", () => {
  const args = collectWorkerExtraArgs({
    dataPlaneUrl: "https://dp.internal",
    reconnect: false,
  });
  assertEquals(args, [
    "--data-plane-url",
    "https://dp.internal",
    "--no-reconnect",
  ]);
});
