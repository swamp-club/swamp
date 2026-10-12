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
  filterOutputs,
  type ModelOutput,
  outputPips,
  outputRunRoute,
  usageByModel,
} from "./model_executions.ts";

const out = (o: Partial<ModelOutput> & { id: string }): ModelOutput => ({
  definitionId: "def-a",
  modelName: "a",
  methodName: "execute",
  status: "succeeded",
  startedAt: "2026-10-12T10:00:00.000Z",
  ...o,
});

const outputs: ModelOutput[] = [
  out({ id: "1", startedAt: "2026-10-10T10:00:00.000Z" }),
  out({ id: "2", startedAt: "2026-10-12T10:00:00.000Z", status: "failed" }),
  out({
    id: "3",
    definitionId: "def-b",
    modelName: "b",
    startedAt: "2026-10-11T10:00:00.000Z",
  }),
  out({
    id: "4",
    startedAt: "2026-10-12T11:00:00.000Z",
    methodName: "sync",
    triggeredBy: "workflow",
    workflowName: "nightly",
    workflowRunId: "run-1",
    stepName: "sync-all",
  }),
];

Deno.test("filterOutputs: keeps one model's outputs newest first", () => {
  assertEquals(
    filterOutputs(outputs, { modelName: "a" }).map((o) => o.id),
    ["4", "2", "1"],
  );
  assertEquals(
    filterOutputs(outputs, { modelId: "def-b" }).map((o) => o.id),
    ["3"],
  );
});

Deno.test("filterOutputs: applies the time window when serve did not", () => {
  assertEquals(
    filterOutputs(outputs, {
      since: "2026-10-11T00:00:00.000Z",
      until: "2026-10-12T10:30:00.000Z",
    }).map((o) => o.id),
    ["2", "3"],
  );
});

Deno.test("outputPips: a workflow-run output links to its run", () => {
  const [pip] = outputPips([outputs[3]]);
  assertEquals(pip.runId, "run-1");
  assertEquals(pip.workflowName, "nightly");
  assertEquals(pip.id, "4");
  assertEquals(pip.label, "sync via nightly › sync-all");
});

Deno.test("outputPips: a direct run has no link and is titled by its method", () => {
  const [pip] = outputPips([out({ id: "9", durationMs: 1200 })]);
  assertEquals(pip.workflowName, undefined);
  assertEquals(pip.runId, "9");
  assertEquals(pip.duration, 1200);
  assertEquals(pip.label, "execute · manual");
});

Deno.test("outputRunRoute: links only when the run is known", () => {
  assertEquals(outputRunRoute(outputs[3]), {
    view: "workflows",
    detail: { kind: "run", workflowName: "nightly", runId: "run-1" },
  });
  assertEquals(outputRunRoute(outputs[0]), null);
  assertEquals(outputRunRoute(out({ id: "x", workflowName: "w" })), null);
});

Deno.test("usageByModel: counts, last use and methods per model by id and name", () => {
  const usage = usageByModel(outputs);
  const a = usage.get("def-a")!;
  assertEquals(usage.get("a"), a);
  assertEquals(a.executions, 3);
  assertEquals(a.failed, 1);
  assertEquals(a.lastStartedAt, "2026-10-12T11:00:00.000Z");
  assertEquals(a.methods, ["sync", "execute"]);
  assertEquals(a.recent.map((o) => o.id), ["4", "2", "1"]);
  assertEquals(usage.get("b")!.executions, 1);
});

Deno.test("usageByModel: caps the recent list", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    out({
      id: String(i),
      startedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    }));
  const a = usageByModel(many, 20).get("a")!;
  assertEquals(a.executions, 30);
  assertEquals(a.recent.length, 20);
  assertEquals(a.recent[0].id, "29");
});
