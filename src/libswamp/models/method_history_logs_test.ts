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
import { Definition } from "../../domain/definitions/definition.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  modelMethodHistoryLogs,
  type ModelMethodHistoryLogsDeps,
  type ModelMethodHistoryLogsEvent,
} from "./method_history_logs.ts";

function makeOutput(opts?: { logFile?: string }): ModelOutput {
  const output = ModelOutput.create({
    definitionId: "00000000-0000-4000-8000-000000000001" as DefinitionId,
    methodName: "start",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "manual",
    },
  });
  if (opts?.logFile) {
    output.setLogFile(opts.logFile);
  }
  return output;
}

function makeDeps(
  overrides?: Partial<ModelMethodHistoryLogsDeps>,
): ModelMethodHistoryLogsDeps {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");
  const output = makeOutput({ logFile: "/tmp/log.txt" });
  return {
    isPartialId: () => true,
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: output,
      }),
    findDefinition: () => Promise.resolve({ definition, type: modelType }),
    findLatestOutput: () => Promise.resolve(output),
    getModelName: () => Promise.resolve("my-model"),
    readLogFile: () =>
      Promise.resolve({ lines: ["line1"], path: "/tmp/log.txt" }),
    toRelativePath: (_repoDir, path) => path,
    ...overrides,
  };
}

Deno.test("modelMethodHistoryLogs yields log data", async () => {
  const deps = makeDeps();
  const events = await collect<ModelMethodHistoryLogsEvent>(
    modelMethodHistoryLogs(createLibSwampContext(), deps, {
      outputIdOrModelName: "out-123",
      repoDir: "/tmp",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelMethodHistoryLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.type, "log");
});

Deno.test("modelMethodHistoryLogs yields no_log_file", async () => {
  const outputWithoutLog = makeOutput();
  const deps = makeDeps({
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: outputWithoutLog,
      }),
  });
  const events = await collect<ModelMethodHistoryLogsEvent>(
    modelMethodHistoryLogs(createLibSwampContext(), deps, {
      outputIdOrModelName: "out-old",
      repoDir: "/tmp",
    }),
  );

  const completed = events[1] as Extract<
    ModelMethodHistoryLogsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.type, "no_log_file");
});

Deno.test("modelMethodHistoryLogs falls through to model name lookup", async () => {
  const deps = makeDeps({
    isPartialId: () => false,
  });
  const events = await collect<ModelMethodHistoryLogsEvent>(
    modelMethodHistoryLogs(createLibSwampContext(), deps, {
      outputIdOrModelName: "my-model",
      repoDir: "/tmp",
    }),
  );

  assertEquals(events[1].kind, "completed");
});
