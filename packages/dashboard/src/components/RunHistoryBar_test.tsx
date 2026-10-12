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

// The router reads the page location when it loads, and the dashboard's
// browser globals aren't in Deno's test types. Each test file runs in its
// own isolate, so stubbing them here touches nothing else.
declare global {
  var history: {
    state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void;
  };
}
if (!globalThis.location) {
  Object.defineProperty(globalThis, "location", {
    value: new URL("http://localhost/"),
    configurable: true,
  });
}
const { RunHistoryBar } = await import("./RunHistoryBar.tsx");
const { FailureLink, failureHref } = await import("./FailureLink.tsx");

Deno.test("failureHref: run path with the failure focus param, segments encoded", () => {
  assertEquals(
    failureHref("@acme/deploy api", "run-1"),
    "/dashboard/workflows/@acme%2Fdeploy%20api/runs/run-1?focus=failure",
  );
});

Deno.test("RunHistoryBar: failed pips link to the failure, others to the run", () => {
  const html = renderToStaticMarkup(
    <RunHistoryBar
      workflowName="deploy"
      runs={[
        { runId: "run-failed", status: "failed" },
        { runId: "run-ok", status: "succeeded" },
      ]}
    />,
  );
  assertStringIncludes(
    html,
    'href="/dashboard/workflows/deploy/runs/run-failed?focus=failure"',
  );
  assertStringIncludes(html, 'href="/dashboard/workflows/deploy/runs/run-ok"');
  assertEquals(html.includes("run-ok?focus"), false);
});

Deno.test("FailureLink: a labelled link to the failure", () => {
  const html = renderToStaticMarkup(
    <FailureLink workflowName="deploy" runId="run-failed" />,
  );
  assertStringIncludes(html, 'class="failure-link"');
  assertStringIncludes(html, "runs/run-failed?focus=failure");
  assertStringIncludes(html, ">View failure</a>");
});
