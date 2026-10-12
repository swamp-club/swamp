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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDiagramSpec,
  describeDiagram,
  type ModelDataRow,
  modelExtension,
  type ModelInfo,
  schemaTypeLabel,
} from "./model_diagram_spec.ts";

const base: ModelInfo = {
  name: "echo-shell",
  type: "command/shell",
  version: 3,
  globalArguments: {},
  methods: [{
    name: "execute",
    description: "Run the command",
    arguments: {
      type: "object",
      properties: { run: { type: "string" }, timeout: { type: "integer" } },
    },
  }],
};

const rows: ModelDataRow[] = [
  {
    name: "log",
    type: "file",
    contentType: "text/plain",
    tags: { type: "file", specName: "log", modelName: "echo-shell" },
  },
  {
    name: "result",
    type: "resource",
    contentType: "application/json",
    tags: { type: "resource", specName: "result", modelName: "echo-shell" },
  },
  {
    name: "report-swamp-method-summary",
    type: "report",
    tags: {
      type: "report",
      reportName: "@swamp/method-summary",
      reportScope: "method",
    },
  },
  {
    name: "report-swamp-method-summary-json",
    type: "report",
    tags: {
      type: "report",
      reportName: "@swamp/method-summary",
      reportScope: "method",
    },
  },
];

function group(spec: ReturnType<typeof buildDiagramSpec>, key: string) {
  return spec.groups.find((g) => g.key === key);
}

Deno.test("schemaTypeLabel: names common JSON schema shapes", () => {
  assertEquals(schemaTypeLabel({ type: "string" }), "string");
  assertEquals(
    schemaTypeLabel({ type: "array", items: { type: "string" } }),
    "string[]",
  );
  assertEquals(schemaTypeLabel({ enum: ["a", "b"] }), "enum");
  assertEquals(schemaTypeLabel({ type: ["string", "null"] }), "string");
  assertEquals(schemaTypeLabel({ anyOf: [{}, {}] }), "union");
  assertEquals(schemaTypeLabel(undefined), "any");
});

Deno.test("modelExtension: prefers serve's extension", () => {
  assertEquals(
    modelExtension({
      type: "@acme/aws/ec2",
      extension: { name: "@acme/aws-tools", version: "1.0.0" },
    }),
    { name: "@acme/aws-tools", version: "1.0.0", inferred: false },
  );
});

Deno.test("modelExtension: infers a scoped type's extension and hides built-ins", () => {
  assertEquals(modelExtension({ type: "@acme/aws/ec2" }), {
    name: "@acme/aws",
    inferred: true,
  });
  assertEquals(modelExtension({ type: "command/shell" }), null);
  assertEquals(modelExtension({ type: "@" }), null);
});

Deno.test("buildDiagramSpec: without serve's new fields falls back to schema, data and reports", () => {
  const spec = buildDiagramSpec(base, rows);
  // No global arguments: methods carry the inputs, no empty argument group.
  assertEquals(group(spec, "arguments"), undefined);
  const methods = group(spec, "methods")!;
  assertEquals(methods.nodes[0].label, "execute()");
  assertEquals(methods.nodes[0].detail, "run, timeout");
  const outputs = group(spec, "outputs")!;
  assertEquals(outputs.nodes.map((n) => n.label), ["log", "result"]);
  assertEquals(outputs.nodes[0].kind, "file");
  assertEquals(outputs.nodes[0].to, {
    view: "models",
    detail: { kind: "data", modelName: "echo-shell", dataName: "log" },
  });
  const reports = group(spec, "reports")!;
  assertEquals(reports.nodes.length, 1);
  assertEquals(reports.nodes[0].label, "@swamp/method-summary");
  assertEquals(reports.nodes[0].to, {
    view: "models",
    detail: {
      kind: "report",
      modelName: "echo-shell",
      reportName: "@swamp/method-summary",
    },
  });
  assertEquals(spec.extension, null);
  assertEquals(spec.model.summary, "1 method");
});

Deno.test("buildDiagramSpec: global arguments come from the schema with types and required", () => {
  const spec = buildDiagramSpec({
    ...base,
    globalArguments: { region: "us-east-1" },
    globalArgumentsSchema: {
      type: "object",
      properties: {
        region: { type: "string", description: "AWS region" },
        tags: { type: "object" },
      },
      required: ["region"],
    },
  }, []);
  const args = group(spec, "arguments")!;
  assertEquals(args.nodes.map((n) => [n.label, n.detail]), [
    ["region", "string · required"],
    ["tags", "object"],
  ]);
  assertEquals(args.nodes[0].description, "AWS region");
});

Deno.test("buildDiagramSpec: argument keys stand in when there is no schema", () => {
  const spec = buildDiagramSpec({
    ...base,
    methods: [],
    globalArguments: { count: 3, name: "x" },
  }, []);
  assertEquals(
    group(spec, "arguments")!.nodes.map((n) => [n.label, n.detail]),
    [["count", "number"], ["name", "string"]],
  );
});

Deno.test("buildDiagramSpec: with serve's fields uses declared outputs, reports and extension", () => {
  const spec = buildDiagramSpec({
    ...base,
    type: "@acme/aws/ec2",
    dataOutputs: [
      { specName: "result", kind: "resource", description: "Instance state" },
      { specName: "log", kind: "file", contentType: "text/plain" },
      { specName: "snapshot", kind: "resource" },
    ],
    reports: [{ name: "@acme/cost", description: "Monthly cost" }],
    extension: { name: "@acme/aws", version: "1.4.0" },
  }, rows);
  const outputs = group(spec, "outputs")!;
  assertEquals(outputs.nodes.map((n) => [n.label, n.detail]), [
    ["result", "resource · written"],
    ["log", "file · text/plain · written"],
    ["snapshot", "resource · not written yet"],
  ]);
  assertEquals(outputs.nodes[2].to, null);
  assertEquals(outputs.nodes[0].description, "Instance state");
  const reports = group(spec, "reports")!;
  assertEquals(reports.nodes.map((n) => [n.label, n.detail]), [
    ["@acme/cost", "not generated yet"],
    ["@swamp/method-summary", "method report"],
  ]);
  assertEquals(spec.extension, {
    name: "@acme/aws",
    version: "1.4.0",
    inferred: false,
  });
});

Deno.test("buildDiagramSpec: a model with nothing shows placeholders, not empty columns", () => {
  const spec = buildDiagramSpec({ name: "bare", type: "x/y" }, []);
  assertEquals(group(spec, "arguments")!.nodes[0].kind, "placeholder");
  assertEquals(group(spec, "outputs")!.nodes[0].label, "No outputs yet");
  assertEquals(group(spec, "reports"), undefined);
});

Deno.test("buildDiagramSpec: a stale definition is labelled", () => {
  assertEquals(
    buildDiagramSpec({ ...base, staleness: "upgradable" }, []).model.stale,
    "upgrade available",
  );
  assertEquals(
    buildDiagramSpec({ ...base, staleness: "current" }, []).model.stale,
    undefined,
  );
});

Deno.test("describeDiagram: summarises every group in words", () => {
  const text = describeDiagram(
    buildDiagramSpec({ ...base, type: "@acme/aws/ec2" }, rows),
  );
  assertStringIncludes(text, "Model echo-shell of type @acme/aws/ec2");
  assertStringIncludes(text, "extension @acme/aws (inferred from its type)");
  assertStringIncludes(text, "Offers 1 method: execute()");
  assertStringIncludes(text, "Writes 2 outputs: log, result");
  assertStringIncludes(text, "Generates 1 report: @swamp/method-summary");
});
