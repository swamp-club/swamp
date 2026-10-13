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

import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import { Command } from "@cliffy/command";
import {
  type CommandSyntax,
  definingModuleOf,
  PREFERRED_SPELLING_EXAMPLE,
  recordDefiningModule,
  subcommandSyntax,
  withPreferredExample,
} from "./command_syntax.ts";

Deno.test("subcommandSyntax: appends the word to the parent invocation", () => {
  const parent: CommandSyntax = { invocation: "swamp model", surface: "model" };
  assertEquals(subcommandSyntax(parent, "output"), {
    invocation: "swamp model output",
    surface: "model",
  });
});

Deno.test("subcommandSyntax: nests for deeper subcommands and keeps the surface", () => {
  const root: CommandSyntax = {
    invocation: "swamp behavior",
    surface: "behavior",
  };
  const leaf = subcommandSyntax(
    subcommandSyntax(subcommandSyntax(root, "method"), "history"),
    "get",
  );
  assertEquals(leaf.invocation, "swamp behavior method history get");
  assertEquals(leaf.surface, "behavior");
});

Deno.test("subcommandSyntax: returns a new value and leaves the parent unchanged", () => {
  const parent: CommandSyntax = { invocation: "swamp model", surface: "model" };
  const child = subcommandSyntax(parent, "get");
  assertNotStrictEquals(child, parent);
  assertEquals(parent.invocation, "swamp model");
});

Deno.test("subcommandSyntax: does not inherit the parent's preferred spelling", () => {
  const parent: CommandSyntax = {
    invocation: "swamp model output",
    surface: "model",
    preferred: "swamp behavior output my-server",
  };
  assertEquals(subcommandSyntax(parent, "get").preferred, undefined);
});

Deno.test("withPreferredExample: adds the preferred spelling as the last example", () => {
  const command = withPreferredExample(
    new Command().example("First", "swamp model get a"),
    {
      preferred: "swamp behavior get a",
    },
  );
  assertEquals(
    command.getExamples().map((e) => [e.name, e.description]),
    [
      ["First", "swamp model get a"],
      [PREFERRED_SPELLING_EXAMPLE, "swamp behavior get a"],
    ],
  );
});

Deno.test("withPreferredExample: adds nothing without a preferred spelling", () => {
  const command = withPreferredExample(
    new Command().example("First", "swamp behavior get a"),
    {},
  );
  assertEquals(command.getExamples().length, 1);
});

Deno.test("recordDefiningModule: definingModuleOf reads back the recorded module", () => {
  const command = new Command();
  assertEquals(definingModuleOf(command), undefined);
  assertStrictEquals(
    recordDefiningModule(command, "file:///x/model_get.ts"),
    command,
  );
  assertEquals(definingModuleOf(command), "file:///x/model_get.ts");
  // Not enumerable, so a walk over the command's properties skips it.
  const [key] = Object.getOwnPropertySymbols(command).filter((symbol) =>
    symbol.description === "swamp.cli.commandDefiningModule"
  );
  assertEquals(
    Object.getOwnPropertyDescriptor(command, key)?.enumerable,
    false,
  );
});
