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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  workspaceAbsenceText,
  WorkspaceUnavailable,
} from "./WorkspaceUnavailable.tsx";

Deno.test("workspaceAbsenceText: says the workspace does not exist", () => {
  assertEquals(
    workspaceAbsenceText("data", { kind: "absent" }),
    "There is no workspace named data here.",
  );
});

Deno.test("workspaceAbsenceText: names the state of a workspace that is not running", () => {
  assertEquals(
    workspaceAbsenceText("data", { kind: "unavailable", state: "stopped" }),
    "The workspace data is stopped.",
  );
  assertStringIncludes(
    workspaceAbsenceText("data", { kind: "unavailable", state: "starting" }),
    "is starting",
  );
  assertStringIncludes(
    workspaceAbsenceText("data", { kind: "unavailable", state: "backoff" }),
    "is starting",
  );
  assertEquals(
    workspaceAbsenceText("data", { kind: "unavailable", state: null }),
    "The workspace data is not running.",
  );
  assertEquals(
    workspaceAbsenceText("data", { kind: "unavailable", state: "refused" }),
    "The workspace data is not running (refused).",
  );
});

Deno.test("WorkspaceUnavailable: shows the reason in place of a sign-in form", () => {
  const html = renderToStaticMarkup(
    <WorkspaceUnavailable
      workspace="data"
      absence={{ kind: "unavailable", state: "stopped" }}
    />,
  );
  assertStringIncludes(html, 'role="status"');
  assertStringIncludes(html, "The workspace data is stopped.");
  assertEquals(html.includes("<form"), false);
});
