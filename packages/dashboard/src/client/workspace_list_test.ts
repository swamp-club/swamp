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
import { parseWorkspaceList } from "./workspace_list.ts";

Deno.test("parseWorkspaceList: a fixed repo is not switchable", () => {
  assertEquals(
    parseWorkspaceList({
      workspaces: [{ name: "repo1", path: "/r/repo1" }],
      switchable: false,
    }),
    { workspaces: [{ name: "repo1", path: "/r/repo1" }], switchable: false },
  );
});

Deno.test("parseWorkspaceList: workspace mode is switchable, with or without the field", () => {
  const workspaces = [{ name: "a", path: "/a" }, { name: "b", path: "/b" }];
  assertEquals(parseWorkspaceList({ workspaces, switchable: true }), {
    workspaces,
    switchable: true,
  });
  assertEquals(parseWorkspaceList({ workspaces }).switchable, true);
});

Deno.test("parseWorkspaceList: drops malformed entries and survives a bad body", () => {
  assertEquals(
    parseWorkspaceList({ workspaces: [{ name: "a", path: "/a" }, { name: 1 }] })
      .workspaces,
    [{ name: "a", path: "/a" }],
  );
  assertEquals(parseWorkspaceList(null), { workspaces: [], switchable: true });
});
