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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildCommandIndex,
  loadCommandIndex,
  rootCommands,
} from "./command_index.ts";

const vault = { id: "vault" };
const repo = { id: "repo" };
const init = { id: "init" };
const help = { id: "help" };

Deno.test("rootCommands: lists top-level commands by registered name, hidden included", () => {
  let askedForHidden: boolean | undefined;
  const node = (name: string) => ({ getName: () => name, getCommands: () => [] });
  const tree = {
    getName: () => "swamp",
    getCommands: (hidden?: boolean) => {
      askedForHidden = hidden;
      return [node("vault"), node("audit")];
    },
  };
  assertEquals(rootCommands(tree).map((r) => r.name), ["vault", "audit"]);
  assertEquals(askedForHidden, true);
});

Deno.test("buildCommandIndex: maps a command to the file that exports its object", () => {
  const index = buildCommandIndex(
    [{ name: "vault", command: vault }],
    new Map([
      ["src/cli/commands/vault.ts", [vault, "a string export"]],
      ["src/cli/commands/other.ts", [{ id: "vault" }]],
    ]),
  );
  assertEquals(index, { vault: "src/cli/commands/vault.ts" });
});

Deno.test("buildCommandIndex: the registered name wins over the file name", () => {
  const index = buildCommandIndex(
    [{ name: "first-rule", command: vault }],
    new Map([["src/cli/commands/invite_link.ts", [vault]]]),
  );
  assertEquals(index, { "first-rule": "src/cli/commands/invite_link.ts" });
});

Deno.test("buildCommandIndex: two commands defined in one file both resolve to it", () => {
  const index = buildCommandIndex(
    [{ name: "init", command: init }, { name: "repo", command: repo }],
    new Map([["src/cli/commands/repo_init.ts", [init, repo]]]),
  );
  assertEquals(index, {
    init: "src/cli/commands/repo_init.ts",
    repo: "src/cli/commands/repo_init.ts",
  });
});

Deno.test("buildCommandIndex: an unexported root uses its declared file", () => {
  const index = buildCommandIndex([{ name: "help", command: help }], new Map());
  assertEquals(index, { help: "src/cli/commands/help.ts" });
});

Deno.test("buildCommandIndex: a root no file exports is an error, not an omission", () => {
  assertThrows(
    () =>
      buildCommandIndex(
        [{ name: "vault", command: vault }, { name: "new", command: {} }],
        new Map([["src/cli/commands/vault.ts", [vault]]]),
      ),
    Error,
    "new is exported by no command file",
  );
});

Deno.test("buildCommandIndex: a command exported by two files is an error", () => {
  assertThrows(
    () =>
      buildCommandIndex(
        [{ name: "vault", command: vault }],
        new Map([
          ["src/cli/commands/b.ts", [vault]],
          ["src/cli/commands/a.ts", [vault]],
        ]),
      ),
    Error,
    "vault is exported by src/cli/commands/a.ts and src/cli/commands/b.ts",
  );
});

Deno.test("loadCommandIndex: refuses a path outside the command directory before importing it", async () => {
  for (
    const file of [
      "scripts/compile.ts",
      "src/cli/commands/../mod.ts",
      "src/cli/commands/nested/thing.ts",
      "src/cli/commands/data.json",
    ]
  ) {
    await assertRejects(
      () => loadCommandIndex("/nonexistent", [file]),
      Error,
      "not a command file",
    );
  }
});
