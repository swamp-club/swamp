// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { resolvePrimaryTool } from "./primary_tool.ts";
import type { RepoMarkerData } from "../../infrastructure/persistence/repo_marker_repository.ts";

const baseMarker: RepoMarkerData = {
  swampVersion: "1.0.0",
  initializedAt: "2024-01-15T10:30:00.000Z",
};

Deno.test("resolvePrimaryTool falls back to claude when marker is null", () => {
  assertEquals(resolvePrimaryTool(null), "claude");
});

Deno.test("resolvePrimaryTool falls back to claude when tools is missing", () => {
  assertEquals(resolvePrimaryTool({ ...baseMarker }), "claude");
});

Deno.test("resolvePrimaryTool falls back to claude when tools is empty", () => {
  assertEquals(resolvePrimaryTool({ ...baseMarker, tools: [] }), "claude");
});

Deno.test("resolvePrimaryTool returns the single enrolled tool", () => {
  assertEquals(resolvePrimaryTool({ ...baseMarker, tools: ["kiro"] }), "kiro");
});

Deno.test("resolvePrimaryTool returns the first tool in a multi-tool list", () => {
  assertEquals(
    resolvePrimaryTool({
      ...baseMarker,
      tools: ["claude", "kiro", "opencode"],
    }),
    "claude",
  );
});
