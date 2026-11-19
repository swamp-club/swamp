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
import {
  hostedWorkspaceAddress,
  splitWorkspaceAddress,
} from "./workspace_address.ts";

Deno.test("splitWorkspaceAddress: names the host and the workspace", () => {
  assertEquals(splitWorkspaceAddress("https://host.example/w/team-a"), {
    hostAddress: "https://host.example",
    name: "team-a",
  });
});

Deno.test("splitWorkspaceAddress: a host behind a path keeps its path", () => {
  assertEquals(
    splitWorkspaceAddress("https://proxy.example/swamp/w/team-a"),
    { hostAddress: "https://proxy.example/swamp", name: "team-a" },
  );
});

Deno.test("splitWorkspaceAddress: keeps a non-default port", () => {
  assertEquals(splitWorkspaceAddress("http://127.0.0.1:9000/w/a1"), {
    hostAddress: "http://127.0.0.1:9000",
    name: "a1",
  });
});

Deno.test("splitWorkspaceAddress: an address with no workspace segment names none", () => {
  assertEquals(splitWorkspaceAddress("https://host.example"), null);
  assertEquals(splitWorkspaceAddress("https://host.example/w"), null);
  assertEquals(splitWorkspaceAddress("https://host.example/w/"), null);
  assertEquals(splitWorkspaceAddress("https://host.example/x/team"), null);
});

Deno.test("splitWorkspaceAddress: a path below the workspace segment names none", () => {
  assertEquals(splitWorkspaceAddress("https://host.example/w/team/api"), null);
});

Deno.test("splitWorkspaceAddress: an invalid workspace name names none", () => {
  assertEquals(splitWorkspaceAddress("https://host.example/w/Team"), null);
  assertEquals(splitWorkspaceAddress("https://host.example/w/-team"), null);
});

Deno.test("splitWorkspaceAddress: an unparseable address names none", () => {
  assertEquals(splitWorkspaceAddress("not a url"), null);
});

Deno.test("hostedWorkspaceAddress: appends the workspace segment", () => {
  assertEquals(
    hostedWorkspaceAddress("https://host.example/swamp", "team-a"),
    "https://host.example/swamp/w/team-a",
  );
});
