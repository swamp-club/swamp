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
import { commandSurfaceFromArgs } from "./command_surface_args.ts";

Deno.test("commandSurfaceFromArgs: the model tree reads model", () => {
  assertEquals(commandSurfaceFromArgs(["model", "get", "x"]), "model");
  assertEquals(
    commandSurfaceFromArgs(["model", "method", "run", "x", "go"]),
    "model",
  );
});

Deno.test("commandSurfaceFromArgs: behavior and its alias read behavior", () => {
  assertEquals(commandSurfaceFromArgs(["behavior", "get", "x"]), "behavior");
  assertEquals(commandSurfaceFromArgs(["behaviour", "get", "x"]), "behavior");
});

Deno.test("commandSurfaceFromArgs: global options before the command word are skipped", () => {
  assertEquals(
    commandSurfaceFromArgs(["--json", "-v", "model", "delete", "x"]),
    "model",
  );
  assertEquals(
    commandSurfaceFromArgs(["--repo-dir", "/r", "model", "get", "x"]),
    "model",
  );
});

Deno.test("commandSurfaceFromArgs: commands outside both trees read behavior", () => {
  assertEquals(
    commandSurfaceFromArgs(["data", "get", "model", "x"]),
    "behavior",
  );
  assertEquals(commandSurfaceFromArgs(["extension", "push"]), "behavior");
  assertEquals(commandSurfaceFromArgs([]), "behavior");
});
