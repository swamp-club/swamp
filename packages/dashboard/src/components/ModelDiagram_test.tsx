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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelDiagram } from "./ModelDiagram.tsx";
import {
  buildDiagramSpec,
  type ModelDataRow,
  type ModelInfo,
} from "./model_diagram_spec.ts";

const model: ModelInfo = {
  name: "echo-shell",
  type: "command/shell",
  version: 2,
  globalArguments: {},
  methods: [{
    name: "execute",
    description: "Run the command",
    arguments: { type: "object", properties: { run: { type: "string" } } },
  }],
};

const rows: ModelDataRow[] = [
  { name: "log", type: "file", contentType: "text/plain", tags: {} },
  {
    name: "report-swamp-method-summary",
    type: "report",
    tags: { type: "report", reportName: "@swamp/method-summary" },
  },
];

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

Deno.test("ModelDiagram: renders an old server's model from its methods and data", () => {
  const html = renderToStaticMarkup(
    <ModelDiagram spec={buildDiagramSpec(model, rows)} />,
  );
  // Both orientations render; CSS shows one.
  assertStringIncludes(html, 'data-orientation="horizontal"');
  assertStringIncludes(html, 'data-orientation="vertical"');
  assertStringIncludes(html, "echo-shell");
  assertStringIncludes(html, "execute()");
  // Outputs and reports link to their pages.
  assertStringIncludes(html, 'href="/dashboard/models/echo-shell/data/log"');
  assertStringIncludes(html, "/dashboard/models/echo-shell/reports/");
  assertStringIncludes(html, 'aria-label="Output log, file · text/plain"');
  // A built-in type has no extension frame.
  assertEquals(html.includes("md-frame"), false);
  // The text alternative names everything.
  assertStringIncludes(html, "Writes 1 output: log.");
  assertStringIncludes(html, "aria-describedby");
});

Deno.test("ModelDiagram: renders serve's declared outputs, reports and extension", () => {
  const html = renderToStaticMarkup(
    <ModelDiagram
      spec={buildDiagramSpec({
        ...model,
        type: "@acme/aws/ec2",
        globalArgumentsSchema: {
          type: "object",
          properties: { region: { type: "string" } },
          required: ["region"],
        },
        dataOutputs: [
          { specName: "instance", kind: "resource", description: "State" },
        ],
        reports: [{ name: "@acme/cost" }],
        extension: { name: "@acme/aws", version: "1.4.0" },
        staleness: "upgradable",
      }, [])}
    />,
  );
  assertStringIncludes(html, "region");
  assertStringIncludes(html, "string · required");
  assertStringIncludes(html, "instance");
  assertStringIncludes(html, "resource · not written yet");
  assertStringIncludes(html, "@acme/cost");
  assertStringIncludes(html, "@acme/aws · v1.4.0");
  assertStringIncludes(html, 'href="/dashboard/extensions"');
  assertStringIncludes(html, "upgrade available");
  // An output that was never written has nothing to link to.
  assertEquals(html.includes("/data/instance"), false);
});

Deno.test("ModelDiagram: an inferred extension is labelled and not linked", () => {
  const html = renderToStaticMarkup(
    <ModelDiagram
      spec={buildDiagramSpec({ ...model, type: "@acme/aws/ec2" }, rows)}
    />,
  );
  assertStringIncludes(html, "@acme/aws · inferred");
  assertStringIncludes(html, "md-frame is-inferred");
  assertEquals(html.includes('href="/dashboard/extensions"'), false);
});

Deno.test("ModelDiagram: many outputs collapse behind an accessible toggle", () => {
  const many: ModelDataRow[] = Array.from({ length: 14 }, (_, i) => ({
    name: `item-${String(i).padStart(2, "0")}`,
    type: "resource",
    tags: {},
  }));
  const html = renderToStaticMarkup(
    <ModelDiagram spec={buildDiagramSpec(model, many)} />,
  );
  assertStringIncludes(html, "+9 more");
  assertStringIncludes(html, 'role="button"');
  assertStringIncludes(html, 'aria-expanded="false"');
  assertStringIncludes(html, 'aria-label="Show 9 more outputs"');
  // Five visible per orientation, the rest folded away.
  assertEquals(count(html, "/data/item-"), 10);
  assert(!html.includes("item-13</text>"));
});

Deno.test("ModelDiagram: long names are cut in the box and kept whole in the tooltip", () => {
  const long = "an-extraordinarily-long-output-name-for-a-box";
  const html = renderToStaticMarkup(
    <ModelDiagram
      spec={buildDiagramSpec(model, [{ name: long, type: "resource" }])}
    />,
  );
  assertStringIncludes(html, `<title>${long}`);
  assertStringIncludes(html, "…</text>");
});
