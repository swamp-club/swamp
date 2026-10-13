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
import { TriggerFlow } from "./TriggerFlow.tsx";
import type { FlowSpec } from "./trigger_flow.ts";

const spec: FlowSpec = {
  trigger: {
    kind: "schedule",
    title: "*/5 * * * *",
    lines: ["Every 5 minutes"],
  },
  inputs: ["region = eu", "size = 3"],
  workflowName: "deploy-api",
  jobs: [
    { name: "build", dependsOn: [], stepCount: 2 },
    { name: "test", dependsOn: ["build"], stepCount: 1 },
    { name: "lint", dependsOn: [], stepCount: 1 },
    { name: "ship", dependsOn: ["test", "lint"], stepCount: 3 },
  ],
};

Deno.test("TriggerFlow: renders nodes, a workflow link and an accessible label", () => {
  const html = renderToStaticMarkup(<TriggerFlow spec={spec} />);
  assertStringIncludes(html, 'role="img"');
  assertStringIncludes(
    html,
    'aria-label="*/5 * * * * starts deploy-api, which runs build, test, lint, ship"',
  );
  assertStringIncludes(html, 'href="/dashboard/workflows/deploy-api"');
  assertStringIncludes(html, "Every 5 minutes");
  assertStringIncludes(html, "region = eu");
  assertStringIncludes(html, "3 steps");
});

Deno.test("TriggerFlow: escapes names", () => {
  const html = renderToStaticMarkup(
    <TriggerFlow spec={{ ...spec, workflowName: "<script>x</script>" }} />,
  );
  assertEquals(html.includes("<script>"), false);
});
