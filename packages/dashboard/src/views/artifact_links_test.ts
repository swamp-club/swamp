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
import {
  dataRowLink,
  partitionModelData,
  stepArtifactLink,
  workflowReportLinks,
} from "./artifact_links.ts";

const METHOD_SUMMARY = {
  type: "report",
  reportName: "@swamp/method-summary",
  reportScope: "method",
  modelName: "collector",
};

Deno.test("stepArtifactLink: model data links to its owner's exact version", () => {
  assertEquals(
    stepArtifactLink({
      dataId: "d1",
      name: "state",
      version: 7,
      tags: { type: "resource", modelName: "incidents" },
    }),
    {
      label: "state v7",
      to: {
        view: "models",
        detail: {
          kind: "data",
          modelName: "incidents",
          dataName: "state",
          version: 7,
        },
      },
    },
  );
});

Deno.test("stepArtifactLink: each step's method summary links to its own model", () => {
  const a = stepArtifactLink({
    dataId: "a",
    name: "report-swamp-method-summary",
    version: 1,
    tags: METHOD_SUMMARY,
  });
  const b = stepArtifactLink({
    dataId: "b",
    name: "report-swamp-method-summary",
    version: 1,
    tags: { ...METHOD_SUMMARY, modelName: "notifier" },
  });
  assertEquals(a?.label, "@swamp/method-summary");
  assertEquals(
    a?.to?.detail,
    {
      kind: "data",
      modelName: "collector",
      dataName: "report-swamp-method-summary",
      version: 1,
    },
  );
  assertEquals(
    b?.to?.detail?.kind === "data" && b.to.detail.modelName,
    "notifier",
  );
});

Deno.test("stepArtifactLink: a report's JSON half is hidden", () => {
  assertEquals(
    stepArtifactLink({
      dataId: "j",
      name: "report-swamp-method-summary-json",
      version: 1,
      tags: METHOD_SUMMARY,
    }),
    null,
  );
});

Deno.test("stepArtifactLink: a report whose own name ends in json is kept", () => {
  const tags = { ...METHOD_SUMMARY, reportName: "@acme/export-json" };
  assertEquals(
    stepArtifactLink({
      dataId: "m",
      name: "report-acme-export-json",
      version: 1,
      tags,
    })?.label,
    "@acme/export-json",
  );
  assertEquals(
    stepArtifactLink({
      dataId: "j",
      name: "report-acme-export-json-json",
      version: 1,
      tags,
    }),
    null,
  );
});

Deno.test("stepArtifactLink: no owner or workflow scope gives a plain label", () => {
  assertEquals(
    stepArtifactLink({ dataId: "x", name: "out", version: 2, tags: {} }),
    { label: "out v2", to: null },
  );
  assertEquals(
    stepArtifactLink({
      dataId: "x",
      name: "report-swamp-workflow-summary",
      version: 2,
      tags: {
        type: "report",
        reportName: "@swamp/workflow-summary",
        reportScope: "workflow",
        modelName: "investigate",
      },
    })?.to,
    null,
  );
});

Deno.test("workflowReportLinks: one run-scoped link per workflow report", () => {
  const tags = {
    type: "report",
    reportName: "@swamp/workflow-summary",
    reportScope: "workflow",
  };
  assertEquals(
    workflowReportLinks(
      [
        {
          dataId: "m",
          name: "report-swamp-workflow-summary",
          version: 3,
          tags,
        },
        {
          dataId: "j",
          name: "report-swamp-workflow-summary-json",
          version: 3,
          tags,
        },
        { dataId: "o", name: "other", version: 1, tags: { type: "resource" } },
      ],
      "investigate",
      "run-1",
    ),
    [{
      label: "@swamp/workflow-summary",
      to: {
        view: "workflows",
        detail: {
          kind: "runReport",
          workflowName: "investigate",
          runId: "run-1",
          reportName: "@swamp/workflow-summary",
        },
      },
    }],
  );
  assertEquals(workflowReportLinks(undefined, "w", "r"), []);
});

Deno.test("dataRowLink: only model-owned rows with a name get a link", () => {
  assertEquals(
    dataRowLink({ name: "state", modelName: "incidents", modelType: "x/y" }),
    {
      view: "models",
      detail: { kind: "data", modelName: "incidents", dataName: "state" },
    },
  );
  assertEquals(dataRowLink({ name: "state", modelName: "" }), null);
  assertEquals(
    dataRowLink({ name: "r", modelName: "wf", modelType: "workflow" }),
    null,
  );
});

Deno.test("partitionModelData: reports by name and variant, JSON halves hidden", () => {
  const { data, reports } = partitionModelData("collector", [
    { name: "state", tags: { type: "resource" } },
    { name: "report-swamp-method-summary", tags: METHOD_SUMMARY },
    { name: "report-swamp-method-summary-json", tags: METHOD_SUMMARY },
    {
      name: "report-acme-cost-eu",
      tags: {
        type: "report",
        reportName: "@acme/cost",
        varySuffix: "eu",
      },
    },
  ]);
  assertEquals(data.map((d) => d.label), ["state"]);
  assertEquals(reports.map((r) => r.label), [
    "@acme/cost · eu",
    "@swamp/method-summary",
  ]);
  assertEquals(reports[0].to?.detail, {
    kind: "report",
    modelName: "collector",
    reportName: "@acme/cost",
    variant: "eu",
  });
});
