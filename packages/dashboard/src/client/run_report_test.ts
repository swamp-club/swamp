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
  resolveRunReport,
  type RunArtifactRef,
  type RunArtifacts,
  runArtifacts,
} from "./run_report.ts";

function reportRef(
  name: string,
  reportName: string,
  version: number,
  extra: Record<string, string> = {},
): RunArtifactRef {
  return {
    dataId: crypto.randomUUID(),
    name,
    version,
    tags: { type: "report", reportName, ...extra },
  };
}

function withJsonTwin(ref: RunArtifactRef): RunArtifactRef[] {
  return [ref, {
    ...ref,
    dataId: crypto.randomUUID(),
    name: `${ref.name}-json`,
  }];
}

Deno.test("resolveRunReport: finds a method report on a step at the run's version", () => {
  const run: RunArtifacts = {
    jobs: [{
      name: "main",
      steps: [{
        name: "collect",
        modelName: "ops",
        dataArtifacts: [
          { dataId: "a", name: "result-main", version: 4, tags: {} },
          ...withJsonTwin(
            reportRef(
              "report-swamp-method-summary",
              "@swamp/method-summary",
              7,
            ),
          ),
        ],
      }],
    }],
  };

  const result = resolveRunReport(run, "@swamp/method-summary");
  if (result.kind !== "found") {
    throw new Error(`expected found, got ${result.kind}`);
  }
  assertEquals(result.artifact.ref.name, "report-swamp-method-summary");
  assertEquals(result.artifact.ref.version, 7);
  assertEquals(result.artifact.stepName, "collect");
  assertEquals(result.artifact.modelName, "ops");
});

Deno.test("resolveRunReport: finds a workflow-scope report with no step", () => {
  const run: RunArtifacts = {
    jobs: [{ name: "main", steps: [{ name: "noop" }] }],
    workflowDataArtifacts: withJsonTwin(
      reportRef(
        "report-swamp-workflow-summary",
        "@swamp/workflow-summary",
        3,
        { reportScope: "workflow" },
      ),
    ),
  };

  const result = resolveRunReport(run, "@swamp/workflow-summary");
  if (result.kind !== "found") {
    throw new Error(`expected found, got ${result.kind}`);
  }
  assertEquals(result.artifact.ref.version, 3);
  assertEquals(result.artifact.stepName, undefined);
});

Deno.test("resolveRunReport: the -json twin is never returned", () => {
  const run: RunArtifacts = {
    workflowDataArtifacts: withJsonTwin(
      reportRef("report-cost", "@acme/cost", 1),
    ).reverse(),
  };
  const result = resolveRunReport(run, "@acme/cost");
  if (result.kind !== "found") {
    throw new Error(`expected found, got ${result.kind}`);
  }
  assertEquals(result.artifact.ref.name, "report-cost");
});

Deno.test("resolveRunReport: a report whose own name ends in -json is still found", () => {
  const run: RunArtifacts = {
    workflowDataArtifacts: [reportRef("report-to-json", "to-json", 1)],
  };
  const result = resolveRunReport(run, "to-json");
  assertEquals(result.kind, "found");
});

Deno.test("resolveRunReport: variants and several steps are ambiguous, not guessed", () => {
  const run: RunArtifacts = {
    jobs: [{
      name: "main",
      steps: [
        {
          name: "a",
          modelName: "m1",
          dataArtifacts: withJsonTwin(
            reportRef(
              "report-swamp-method-summary",
              "@swamp/method-summary",
              2,
            ),
          ),
        },
        {
          name: "b",
          modelName: "m2",
          dataArtifacts: withJsonTwin(
            reportRef(
              "report-swamp-method-summary",
              "@swamp/method-summary",
              5,
            ),
          ),
        },
      ],
    }],
    workflowDataArtifacts: [
      reportRef("report-cost-eu", "@acme/cost", 1, { varySuffix: "eu" }),
      reportRef("report-cost-us", "@acme/cost", 1, { varySuffix: "us" }),
    ],
  };

  const steps = resolveRunReport(run, "@swamp/method-summary");
  if (steps.kind !== "ambiguous") {
    throw new Error(`expected ambiguous, got ${steps.kind}`);
  }
  assertEquals(steps.candidates.map((c) => c.stepName), ["a", "b"]);

  const variants = resolveRunReport(run, "@acme/cost");
  if (variants.kind !== "ambiguous") {
    throw new Error(`expected ambiguous, got ${variants.kind}`);
  }
  assertEquals(variants.candidates.length, 2);
});

Deno.test("resolveRunReport: not found when the run has no such report", () => {
  assertEquals(
    resolveRunReport({}, "@swamp/workflow-summary").kind,
    "notFound",
  );
  assertEquals(
    resolveRunReport(
      { workflowDataArtifacts: [reportRef("report-x", "x", 1)] },
      "y",
    ).kind,
    "notFound",
  );
});

Deno.test("runArtifacts: lists step artifacts before workflow-scope ones", () => {
  const run: RunArtifacts = {
    jobs: [{
      name: "main",
      steps: [{
        name: "s",
        dataArtifacts: [{ dataId: "1", name: "a", version: 1 }],
      }],
    }],
    workflowDataArtifacts: [{ dataId: "2", name: "b", version: 1 }],
  };
  assertEquals(runArtifacts(run).map((a) => a.ref.name), ["a", "b"]);
});
