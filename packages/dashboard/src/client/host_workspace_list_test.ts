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
  hostStateMark,
  hostSwitcherEntries,
  parseHostWorkspaceList,
  ROOT_ENTRY_VALUE,
  rootListAccess,
} from "./host_workspace_list.ts";

Deno.test("parseHostWorkspaceList: keeps each workspace's name and state only", () => {
  assertEquals(
    parseHostWorkspaceList({
      data: {
        workspaces: [
          {
            name: "edge-dns",
            address: "https://host.example/w/edge-dns",
            wanted: "active",
            state: "ready",
            restarts: 0,
            reason: null,
            owner: "host",
          },
          { name: "cost", state: null },
        ],
      },
    }),
    [{ name: "edge-dns", state: "ready" }, { name: "cost", state: null }],
  );
});

Deno.test("parseHostWorkspaceList: drops entries it cannot read, reads an unknown state as none, and is null for an unreadable reply", () => {
  assertEquals(
    parseHostWorkspaceList({
      data: {
        workspaces: [{ name: 1 }, null, { name: "" }, {
          name: "a",
          state: "melted",
        }],
      },
    }),
    [{ name: "a", state: null }],
  );
  assertEquals(parseHostWorkspaceList(null), null);
  assertEquals(parseHostWorkspaceList({ data: {} }), null);
  assertEquals(parseHostWorkspaceList({ workspaces: [] }), null);
});

Deno.test("hostStateMark: marks every state but ready, in the workspace page's words", () => {
  assertEquals(hostStateMark("ready"), null);
  assertEquals(hostStateMark("stopped"), "stopped");
  assertEquals(hostStateMark("starting"), "starting");
  assertEquals(hostStateMark("backoff"), "starting");
  assertEquals(hostStateMark("failed"), "failed");
  assertEquals(hostStateMark(null), "not running");
});

Deno.test("hostSwitcherEntries: the root first, then the workspaces by name, each marked unless ready", () => {
  assertEquals(
    hostSwitcherEntries("edge-dns", [
      { name: "zeta", state: "failed" },
      { name: "edge-dns", state: "ready" },
      { name: "cost", state: "stopped" },
    ]),
    [
      { value: ROOT_ENTRY_VALUE, label: "Host root", href: "/dashboard/" },
      { value: "cost", label: "cost (stopped)", href: "/dashboard/w/cost/" },
      { value: "edge-dns", label: "edge-dns", href: "/dashboard/w/edge-dns/" },
      { value: "zeta", label: "zeta (failed)", href: "/dashboard/w/zeta/" },
    ],
  );
});

Deno.test("hostSwitcherEntries: the current workspace is an entry whether or not the list was read or names it", () => {
  const unread = hostSwitcherEntries("edge-dns", null);
  assertEquals(unread.map((e) => e.value), [ROOT_ENTRY_VALUE, "edge-dns"]);
  const missing = hostSwitcherEntries("edge-dns", [
    { name: "cost", state: "ready" },
  ]);
  assertEquals(missing.map((e) => e.value), [
    ROOT_ENTRY_VALUE,
    "cost",
    "edge-dns",
  ]);
  assertEquals(
    hostSwitcherEntries(null, null).map((e) => e.value),
    [ROOT_ENTRY_VALUE],
  );
});

Deno.test("hostSwitcherEntries: a name that needs escaping opens its own dashboard path", () => {
  const [, entry] = hostSwitcherEntries(null, [{
    name: "a b",
    state: "ready",
  }]);
  assertEquals(entry.href, "/dashboard/w/a%20b/");
});

Deno.test("rootListAccess: a root in mode none is read by anyone, any other only with its session", () => {
  assertEquals(rootListAccess("none", false), "read");
  assertEquals(rootListAccess("oauth", true), "read");
  assertEquals(rootListAccess("token", true), "read");
  assertEquals(rootListAccess("oauth", false), "sign-in");
  assertEquals(rootListAccess("token", false), "sign-in");
});
