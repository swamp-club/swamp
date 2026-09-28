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
  contentBytes,
  contentKind,
  type DataItem,
  isRequestedReport,
  latestVersion,
  matchesRunRef,
  pageError,
  pairJsonVersion,
  prettyJson,
  reportJsonName,
  resolveRunReportRefs,
  type RunView,
} from "./data_target.ts";

const SUMMARY = "@swamp/workflow-summary";

function reportRef(name: string, version: number, extra = {}) {
  return {
    dataId: `id-${name}-${version}`,
    name,
    version,
    tags: {
      type: "report",
      reportName: SUMMARY,
      reportScope: "workflow",
      ...extra,
    },
  };
}

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    id: "run-1",
    workflowName: "investigate",
    workflowDataArtifacts: [
      reportRef("report-swamp-workflow-summary", 3),
      reportRef("report-swamp-workflow-summary-json", 4),
    ],
    ...overrides,
  };
}

function item(overrides: Partial<DataItem> = {}): DataItem {
  return {
    id: "id-report-swamp-workflow-summary-3",
    name: "report-swamp-workflow-summary",
    modelName: "investigate",
    modelType: "workflow",
    version: 3,
    contentType: "text/markdown",
    tags: { type: "report", reportName: SUMMARY },
    createdAt: "2026-09-28T10:00:00.000Z",
    ...overrides,
  };
}

Deno.test("resolveRunReportRefs: pairs markdown and JSON refs with their exact versions", () => {
  const refs = resolveRunReportRefs(run(), "investigate", SUMMARY);
  assertEquals(refs.status, "ok");
  if (refs.status !== "ok") return;
  assertEquals(refs.markdown.version, 3);
  assertEquals(refs.json?.version, 4);
});

Deno.test("resolveRunReportRefs: rejects a run from another workflow", () => {
  assertEquals(
    resolveRunReportRefs(run(), "other-workflow", SUMMARY).status,
    "wrong-workflow",
  );
});

Deno.test("resolveRunReportRefs: missing when the run has no such report", () => {
  assertEquals(
    resolveRunReportRefs(run(), "investigate", "@acme/other").status,
    "missing",
  );
  assertEquals(
    resolveRunReportRefs(
      run({ workflowDataArtifacts: undefined }),
      "investigate",
      SUMMARY,
    ).status,
    "missing",
  );
});

Deno.test("resolveRunReportRefs: a report named *-json is not mistaken for JSON", () => {
  const name = "@acme/export-json";
  const refs = resolveRunReportRefs(
    run({
      workflowDataArtifacts: [
        reportRef("report-acme-export-json", 1, { reportName: name }),
        reportRef("report-acme-export-json-json", 1, { reportName: name }),
      ],
    }),
    "investigate",
    name,
  );
  assertEquals(refs.status, "ok");
  if (refs.status !== "ok") return;
  assertEquals(refs.markdown.name, "report-acme-export-json");
  assertEquals(refs.json?.name, "report-acme-export-json-json");
});

Deno.test("matchesRunRef: only the exact recorded workflow artifact matches", () => {
  const ref = reportRef("report-swamp-workflow-summary", 3);
  assertEquals(matchesRunRef(item(), ref), true);
  assertEquals(matchesRunRef(item({ version: 5 }), ref), false);
  assertEquals(matchesRunRef(item({ id: "someone-else" }), ref), false);
  assertEquals(matchesRunRef(item({ modelType: "command/shell" }), ref), false);
});

Deno.test("isRequestedReport: checks name and variant from tags", () => {
  assertEquals(isRequestedReport(item(), SUMMARY), true);
  assertEquals(isRequestedReport(item(), "@swamp/other"), false);
  assertEquals(
    isRequestedReport(item({ tags: { type: "resource" } }), SUMMARY),
    false,
  );
  const varied = item({
    tags: { type: "report", reportName: SUMMARY, varySuffix: "us-east" },
  });
  assertEquals(isRequestedReport(varied, SUMMARY), false);
  assertEquals(isRequestedReport(varied, SUMMARY, "us-east"), true);
  assertEquals(isRequestedReport(item(), SUMMARY, "us-east"), false);
});

Deno.test("reportJsonName: the JSON sibling of a report's markdown", () => {
  assertEquals(reportJsonName(item()), "report-swamp-workflow-summary-json");
  assertEquals(
    reportJsonName(
      item({
        name: "report-swamp-workflow-summary-eu",
        tags: { type: "report", reportName: SUMMARY, varySuffix: "eu" },
      }),
    ),
    "report-swamp-workflow-summary-eu-json",
  );
  assertEquals(reportJsonName(item({ contentType: "application/json" })), null);
  assertEquals(reportJsonName(item({ tags: { type: "resource" } })), null);
});

Deno.test("pairJsonVersion: earliest JSON written at or after the markdown", () => {
  const md = "2026-09-28T10:00:00.000Z";
  assertEquals(
    pairJsonVersion(md, [
      { version: 9, createdAt: "2026-09-28T10:05:00.000Z", isLatest: true },
      { version: 8, createdAt: "2026-09-28T10:00:00.040Z", isLatest: false },
      { version: 7, createdAt: "2026-09-28T09:59:59.990Z", isLatest: false },
    ]),
    8,
  );
});

Deno.test("pairJsonVersion: nothing within a minute means no pair", () => {
  assertEquals(
    pairJsonVersion("2026-09-28T10:00:00.000Z", [
      { version: 2, createdAt: "2026-09-28T10:02:00.000Z", isLatest: true },
      { version: 1, createdAt: "2026-09-28T09:00:00.000Z", isLatest: false },
    ]),
    null,
  );
  assertEquals(pairJsonVersion("not a date", []), null);
});

Deno.test("latestVersion: prefers the isLatest flag", () => {
  assertEquals(
    latestVersion([
      { version: 5, createdAt: "", isLatest: false },
      { version: 4, createdAt: "", isLatest: true },
    ]),
    4,
  );
  assertEquals(latestVersion([]), null);
});

Deno.test("contentKind: by content type and encoding", () => {
  assertEquals(contentKind("text/markdown", "utf-8"), "markdown");
  assertEquals(contentKind("application/json; charset=utf-8", "utf-8"), "json");
  assertEquals(contentKind("application/vnd.api+json", "utf-8"), "json");
  assertEquals(contentKind("application/yaml", "utf-8"), "yaml");
  assertEquals(contentKind("text/plain", "utf-8"), "text");
  assertEquals(contentKind("application/json", "base64"), "binary");
});

Deno.test("prettyJson: formats valid JSON and leaves invalid JSON alone", () => {
  assertEquals(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
  assertEquals(prettyJson("{nope"), "{nope");
});

Deno.test("pageError: maps serve errors to what the reader is told", () => {
  assertEquals(pageError(null, null, false), null);
  assertEquals(
    pageError("denied", { code: "unauthorized" }, true),
    { kind: "denied" },
  );
  assertEquals(
    pageError("x", {
      code: "data_get_failed",
      reason: "not_found",
      entityType: "Data",
    }, true),
    { kind: "gone" },
  );
  assertEquals(
    pageError("x", {
      code: "data_get_failed",
      reason: "not_found",
      entityType: "Data",
    }, false),
    { kind: "not-found", entity: "Data" },
  );
  assertEquals(
    pageError("x", {
      code: "data_get_failed",
      reason: "not_found",
      entityType: "Model",
    }, true),
    { kind: "not-found", entity: "Model" },
  );
  assertEquals(
    pageError("x", {
      code: "workflow_history_get_failed",
      reason: "not_found",
      entityType: "Workflow run or workflow",
    }, true),
    { kind: "not-found", entity: "Workflow run" },
  );
  assertEquals(
    pageError("x", { code: "data_get_failed", reason: "data_pending" }, true),
    { kind: "pending" },
  );
  assertEquals(pageError("WebSocket closed", null, true), {
    kind: "failed",
    message: "WebSocket closed",
  });
});

Deno.test("contentBytes: decodes base64 and encodes text", () => {
  assertEquals(contentBytes("AAEC", "base64"), new Uint8Array([0, 1, 2]));
  assertEquals(contentBytes("hi", "utf-8"), new Uint8Array([104, 105]));
});
