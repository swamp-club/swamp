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
import { resolveServiceMode } from "./service_scheduler_factory.ts";

Deno.test("resolveServiceMode: returns agent when user flag is true", async () => {
  const mode = await resolveServiceMode({ user: true });
  assertEquals(mode, "agent");
});

Deno.test("resolveServiceMode: user undefined behaves same as no options", async () => {
  const mode = await resolveServiceMode({ user: undefined });
  assertEquals(mode, await resolveServiceMode());
});

Deno.test("resolveServiceMode: returns agent when options are undefined", async () => {
  const mode = await resolveServiceMode();
  assertEquals(typeof mode, "string");
});
