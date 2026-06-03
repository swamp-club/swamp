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
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  modelOutputLogs,
  type ModelOutputLogsDeps,
  type ModelOutputLogsEvent,
} from "./output_logs.ts";

function makeOutput(
  opts?: { withLogArtifact?: boolean },
): ModelOutput {
  const output = ModelOutput.create({
    definitionId: "00000000-0000-4000-8000-000000000001" as DefinitionId,
    methodName: "start",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "manual",
    },
  });
  output.markRunning();
  output.markSucceeded();
  if (opts?.withLogArtifact !== false) {
    output.addDataArtifact({
      dataId: crypto.randomUUID(),
      name: "run.log",
      version: 1,
      tags: { type: "log" },
    });
  }
  return output;
}

function makeDeps(
  overrides?: Partial<ModelOutputLogsDeps>,
): ModelOutputLogsDeps {
  const output = makeOutput();
  const modelType = ModelType.create("aws/ec2");
  return {
    isPartialId: () => true,
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output, type: modelType },
      }),
    findDataByName: () => Promise.resolve({}),
    getContent: () =>
      Promise.resolve(new TextEncoder().encode("line1\nline2\n")),
    ...overrides,
  };
}

Deno.test("modelOutputLogs yields log lines", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelOutputLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.lines, ["line1", "line2"]);
  assertEquals(completed.data.totalLines, 2);
});

Deno.test("modelOutputLogs applies tail", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      tail: 1,
    }),
  );

  const completed = events[1] as Extract<
    ModelOutputLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.showingLines, 1);
  assertEquals(completed.data.lines, ["line2"]);
});

Deno.test("modelOutputLogs yields error for invalid ID format", async () => {
  const deps = makeDeps({ isPartialId: () => false });
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "xx",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelOutputLogs yields error when no log artifacts", async () => {
  const outputNoLog = makeOutput({ withLogArtifact: false });
  const modelType = ModelType.create("aws/ec2");
  const deps = makeDeps({
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output: outputNoLog, type: modelType },
      }),
  });
  const events = await collect<ModelOutputLogsEvent>(
    modelOutputLogs(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events[1].kind, "error");
});
