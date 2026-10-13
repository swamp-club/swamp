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

import { assertEquals, assertNotStrictEquals } from "@std/assert";
import { type CommandSyntax, subcommandSyntax } from "./command_syntax.ts";

Deno.test("subcommandSyntax: appends the word to the parent invocation", () => {
  const parent: CommandSyntax = { invocation: "swamp model" };
  assertEquals(subcommandSyntax(parent, "output"), {
    invocation: "swamp model output",
  });
});

Deno.test("subcommandSyntax: nests for deeper subcommands", () => {
  const root: CommandSyntax = { invocation: "swamp behavior" };
  const leaf = subcommandSyntax(
    subcommandSyntax(subcommandSyntax(root, "method"), "history"),
    "get",
  );
  assertEquals(leaf.invocation, "swamp behavior method history get");
});

Deno.test("subcommandSyntax: returns a new value and leaves the parent unchanged", () => {
  const parent: CommandSyntax = { invocation: "swamp model" };
  const child = subcommandSyntax(parent, "get");
  assertNotStrictEquals(child, parent);
  assertEquals(parent.invocation, "swamp model");
});
