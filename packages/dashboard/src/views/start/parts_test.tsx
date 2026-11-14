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
import { launchFailureLine } from "./helpers.ts";
import { LaunchFailureNote } from "./parts.tsx";

Deno.test("LaunchFailureNote: shows the line saying what was tried", () => {
  const html = renderToStaticMarkup(
    <LaunchFailureNote
      failure={launchFailureLine({
        tried: [{ terminal: "ptyxis", chosen: "default", result: "not_found" }],
      }, true)}
    />,
  );
  assertStringIncludes(html, 'role="status"');
  assertStringIncludes(
    html,
    "Still couldn&#x27;t open a terminal. Tried: ptyxis (not found).",
  );
});

Deno.test("LaunchFailureNote: renders nothing without a failure", () => {
  assertEquals(renderToStaticMarkup(<LaunchFailureNote />), "");
});
