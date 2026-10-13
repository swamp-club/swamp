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

import { assertEquals, assertThrows } from "@std/assert";
import { WorkspaceRegistry } from "./workspace_registry.ts";

const entry = (name: string, path: string) => ({
  name,
  path,
  createdAt: "2026-10-11T00:00:00.000Z",
});

Deno.test("WorkspaceRegistry.register: adds a workspace once; the same entry again is a no-op", () => {
  const r = WorkspaceRegistry.empty();
  assertEquals(r.register(entry("a", "/w/a")), true);
  assertEquals(r.register(entry("a", "/w/a")), false);
  assertEquals(r.list().map((e) => e.name), ["a"]);
});

Deno.test("WorkspaceRegistry.register: refuses a taken name or an already registered folder", () => {
  const r = WorkspaceRegistry.fromEntries([entry("a", "/w/a")]);
  assertThrows(() => r.register(entry("a", "/elsewhere")));
  assertThrows(() => r.register(entry("b", "/w/a")));
});

Deno.test("WorkspaceRegistry.remove: drops a workspace by name", () => {
  const r = WorkspaceRegistry.fromEntries([
    entry("a", "/w/a"),
    entry("b", "/b"),
  ]);
  assertEquals(r.remove("a"), true);
  assertEquals(r.remove("a"), false);
  assertEquals(r.list().map((e) => e.name), ["b"]);
});

Deno.test("WorkspaceRegistry.markTrusted: records trust once, by path, for registered workspaces only", () => {
  const r = WorkspaceRegistry.fromEntries([entry("a", "/w/a")]);
  assertEquals(r.isTrusted("/w/a"), false);
  assertEquals(r.markTrusted("/w/other", "2026-10-11T01:00:00.000Z"), false);
  assertEquals(r.markTrusted("/w/a", "2026-10-11T01:00:00.000Z"), true);
  assertEquals(r.markTrusted("/w/a", "2026-10-12T01:00:00.000Z"), false);
  assertEquals(r.isTrusted("/w/a"), true);
  assertEquals(r.get("a")?.trustedAt, "2026-10-11T01:00:00.000Z");
});

Deno.test("WorkspaceRegistry.rememberAgent: keeps the last agent picked, reporting only real changes", () => {
  const r = WorkspaceRegistry.empty();
  assertEquals(r.lastAgent(), undefined);
  assertEquals(r.rememberAgent("codex"), true);
  assertEquals(r.rememberAgent("codex"), false);
  assertEquals(r.rememberAgent("opencode"), true);
  assertEquals(r.lastAgent(), "opencode");
  assertEquals(
    WorkspaceRegistry.fromEntries([entry("a", "/w/a")], "codex").lastAgent(),
    "codex",
  );
});
