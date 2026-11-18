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
import { matchWorkspacePath, workspaceNameUnder } from "./workspace_path.ts";

Deno.test("matchWorkspacePath: a workspace path loses its prefix", () => {
  assertEquals(matchWorkspacePath("/w/edge-dns/api/v1/request"), {
    kind: "workspace",
    name: "edge-dns",
    path: "/api/v1/request",
  });
});

Deno.test("matchWorkspacePath: a bare workspace address and its trailing slash both reach its root path", () => {
  for (const path of ["/w/edge-dns", "/w/edge-dns/"]) {
    assertEquals(matchWorkspacePath(path), {
      kind: "workspace",
      name: "edge-dns",
      path: "/",
    });
  }
});

Deno.test("matchWorkspacePath: the rest of the path keeps its percent-encoding", () => {
  assertEquals(matchWorkspacePath("/w/a/hooks/x%2Fy%20z"), {
    kind: "workspace",
    name: "a",
    path: "/hooks/x%2Fy%20z",
  });
});

Deno.test("matchWorkspacePath: a path under /w/ that names no valid workspace is unknown", () => {
  for (
    const path of [
      "/w",
      "/w/",
      "/w//x",
      "/w/Edge/x",
      "/w/-lead/x",
      "/w/a%2Fb/x",
      "/w/a.b/",
      `/w/${"a".repeat(64)}/`,
    ]
  ) {
    assertEquals(matchWorkspacePath(path), { kind: "unknown" }, path);
  }
});

Deno.test("matchWorkspacePath: every other path goes to the root unchanged", () => {
  for (
    const path of ["/", "/api/v1/request", "/wx/a/", "/W/a/", "/dashboard/w/a/"]
  ) {
    assertEquals(matchWorkspacePath(path), { kind: "root", path }, path);
  }
});

Deno.test("matchWorkspacePath: dot segments are resolved by URL parsing before matching", () => {
  const { pathname } = new URL("http://h/w/a/../b/x");
  assertEquals(matchWorkspacePath(pathname), {
    kind: "workspace",
    name: "b",
    path: "/x",
  });
});

Deno.test("workspaceNameUnder: the name a child's address adds under the root's, or null", () => {
  assertEquals(
    workspaceNameUnder(
      "https://host.example",
      "https://host.example/w/edge-dns",
    ),
    "edge-dns",
  );
  assertEquals(
    workspaceNameUnder(
      "https://host.example/swamp",
      "https://host.example/swamp/w/edge-dns",
    ),
    "edge-dns",
  );
  for (
    const address of [
      "https://host.example",
      "https://host.example/w/",
      "https://host.example/w/Edge",
      "https://host.example/w/edge-dns/more",
      "https://host.example.evil/w/edge-dns",
      "https://other.example/w/edge-dns",
    ]
  ) {
    assertEquals(workspaceNameUnder("https://host.example", address), null);
  }
});
