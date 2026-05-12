// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream } from "../../libswamp/mod.ts";
import type { DataListEvent } from "../../libswamp/mod.ts";
import { createDataListRenderer } from "./data_list.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: DataListEvent[],
): AsyncGenerator<DataListEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("JsonDataListRenderer - completed outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createDataListRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            modelId: "def-1",
            modelName: "my-model",
            modelType: "aws/ec2",
            groups: [],
            total: 0,
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelName, "my-model");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogDataListRenderer - workflow-scope row renders '(workflow)' placeholder", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg = "") => logs.push(msg);

  try {
    const renderer = createDataListRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            workflowId: "wf-1",
            workflowName: "deploy",
            runId: "abcdef0123456789",
            runStatus: "succeeded",
            groups: [
              {
                type: "report",
                items: [
                  {
                    id: "d-step",
                    name: "report-step-summary",
                    version: 1,
                    contentType: "text/markdown",
                    type: "report",
                    streaming: false,
                    size: 100,
                    createdAt: new Date().toISOString(),
                    modelId: "m-1",
                    modelName: "my-model",
                    modelType: "ns/type",
                    jobName: "main",
                    stepName: "build",
                  },
                  {
                    id: "d-wf",
                    name: "report-swamp-workflow-summary",
                    version: 1,
                    contentType: "text/markdown",
                    type: "report",
                    streaming: false,
                    size: 200,
                    createdAt: new Date().toISOString(),
                    modelId: "wf-1",
                    modelName: "",
                    modelType: "workflow",
                  },
                ],
              },
            ],
            total: 2,
          },
        },
      ]),
      renderer.handlers(),
    );

    const joined = logs.join("\n");
    // Step-scoped artifact keeps the "job.step" rendering.
    const stepLine = logs.find((l) => l.includes("report-step-summary"));
    if (!stepLine) {
      throw new Error(`expected step line in logs:\n${joined}`);
    }
    if (!stepLine.includes("main.build")) {
      throw new Error(`expected 'main.build' in step line: ${stepLine}`);
    }
    // Workflow-scoped artifact renders "(workflow)".
    const wfLine = logs.find((l) =>
      l.includes("report-swamp-workflow-summary")
    );
    if (!wfLine) {
      throw new Error(`expected workflow line in logs:\n${joined}`);
    }
    if (!wfLine.includes("(workflow)")) {
      throw new Error(`expected '(workflow)' in workflow line: ${wfLine}`);
    }
  } finally {
    console.log = originalLog;
  }
});

Deno.test("DataListRenderer - error throws UserError", () => {
  const renderer = createDataListRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});
