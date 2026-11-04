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
import { appState } from "./app_approval.ts";

const approval = {
  name: "@acme/cost",
  capabilityKey: "key",
  approvedBy: "user:a",
  approvedAt: "2026-11-04T00:00:00.000Z",
};

Deno.test("appState: no approval is pending", () => {
  assertEquals(appState("key", null), "pending");
});

Deno.test("appState: the approved capability set is enabled", () => {
  assertEquals(appState("key", approval), "enabled");
});

Deno.test("appState: asking for something else goes back for review", () => {
  assertEquals(appState("other", approval), "changed");
});
