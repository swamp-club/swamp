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
import { FrameGuard, isDevLaunch, needsLaunch } from "./frame_guard.ts";

Deno.test("FrameGuard: a built app gets one port", () => {
  const guard = new FrameGuard(false);
  assertEquals(guard.mayGrantPort(), true);
  assertEquals(guard.mayGrantPort(), false);
});

Deno.test("FrameGuard: a built app that loads twice has left", () => {
  const guard = new FrameGuard(false);
  assertEquals(guard.loaded(), false);
  assertEquals(guard.loaded(), true);
});

Deno.test("FrameGuard: a dev server may reload and reconnect", () => {
  const guard = new FrameGuard(true);
  assertEquals(guard.mayGrantPort(), true);
  assertEquals(guard.loaded(), false);
  assertEquals(guard.loaded(), false);
  assertEquals(guard.mayGrantPort(), true);
});

Deno.test("isDevLaunch: tells a loopback URL from a server path", () => {
  assertEquals(isDevLaunch("http://127.0.0.1:5173/"), true);
  assertEquals(isDevLaunch("/app-files/id/index.html"), false);
});

Deno.test("needsLaunch: launches once, and only while connected", () => {
  assertEquals(needsLaunch(true, null), true);
  assertEquals(needsLaunch(false, null), false);
  assertEquals(needsLaunch(true, { url: "/app-files/id/index.html" }), false);
});
