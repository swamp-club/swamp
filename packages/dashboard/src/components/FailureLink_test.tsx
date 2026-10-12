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
import { failureHref, FailureLink } from "./FailureLink.tsx";

Deno.test("failureHref: the run's path with the failure focus", () => {
  assertEquals(
    failureHref("deploy", "abc-123"),
    "/dashboard/workflows/deploy/runs/abc-123?focus=failure",
  );
  assertEquals(
    failureHref("@acme/rotate keys", "r1"),
    "/dashboard/workflows/@acme%2Frotate%20keys/runs/r1?focus=failure",
  );
});

Deno.test("FailureLink: a real link to the failure log", () => {
  const html = renderToStaticMarkup(
    <FailureLink workflowName="deploy" runId="abc-123" />,
  );
  assertStringIncludes(
    html,
    'href="/dashboard/workflows/deploy/runs/abc-123?focus=failure"',
  );
  assertStringIncludes(html, ">View failure</a>");
});
