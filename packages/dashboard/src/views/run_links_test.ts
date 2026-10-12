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
import { parseRoute } from "../routes.ts";
import { failureHref, runHref } from "./run_links.ts";

Deno.test("failureHref: the run page with the failure focused", () => {
  assertEquals(
    failureHref("deploy", "0d6a1f6e-1111-4222-8333-444455556666"),
    "/dashboard/workflows/deploy/runs/0d6a1f6e-1111-4222-8333-444455556666?focus=failure",
  );
});

Deno.test("failureHref: can target one step, encoded", () => {
  const href = failureHref("@acme/deploy", "r1", "push image");
  const url = new URL(href, "https://swamp.test");
  assertEquals(url.searchParams.get("focus"), "failure");
  assertEquals(url.searchParams.get("step"), "push image");
  assertEquals(parseRoute(url.pathname).detail, {
    kind: "run",
    workflowName: "@acme/deploy",
    runId: "r1",
  });
});

Deno.test("runHref: matches the router's path", () => {
  assertEquals(runHref("wf", "r1"), "/dashboard/workflows/wf/runs/r1");
});
