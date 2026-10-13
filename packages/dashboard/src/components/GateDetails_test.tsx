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
import { assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { GateDetails } from "./GateDetails.tsx";

const runId = "0d6a1f6e-1111-4222-8333-444455556666";
const base = {
  workflowName: "release",
  stepName: "sign-off",
  runLink: <a href={`/dashboard/workflows/release/runs/${runId}`}>{runId}</a>,
};

const jobs = [
  { name: "build", dependsOn: [], steps: [{ name: "compile" }] },
  {
    name: "approve",
    dependsOn: [{ job: "build" }],
    steps: [{ name: "sign-off" }],
  },
  { name: "deploy", dependsOn: [{ job: "approve" }], steps: [] },
];

Deno.test("GateDetails: shows the run link and names the gate, prompt and next jobs", () => {
  const html = renderToStaticMarkup(
    <GateDetails {...base} prompt="Ship it?" jobs={jobs} />,
  );
  assertStringIncludes(
    html,
    `href="/dashboard/workflows/release/runs/${runId}"`,
  );
  assertStringIncludes(html, "sign-off");
  assertStringIncludes(html, "Ship it?");
  assertStringIncludes(html, '<span class="mono">approve</span>');
  assertStringIncludes(html, '<span class="mono">deploy</span>');
  assertStringIncludes(html, 'aria-label="Jobs of release"');
  assertStringIncludes(html, "Waits on the gate");
});

Deno.test("GateDetails: a skeleton while jobs load, an error when they fail", () => {
  const loading = renderToStaticMarkup(<GateDetails {...base} jobs={null} />);
  assertStringIncludes(loading, 'aria-busy="true"');
  assertStringIncludes(loading, "Loading the workflow");
  const failed = renderToStaticMarkup(
    <GateDetails {...base} jobs={null} error="denied" />,
  );
  assertStringIncludes(failed, "Couldn&#x27;t load the workflow&#x27;s jobs");
  assertStringIncludes(failed, 'role="alert"');
});
